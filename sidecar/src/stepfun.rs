//! StepFun StepAudio 3 Realtime client over the `v1/realtime` WebSocket.
//!
//! Unlike Gemini Live, a StepFun session cannot be resumed and lasts at most 30 minutes, so a
//! dropped socket ends the call instead of silently losing the conversation.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::audio::{i16_to_le_bytes, le_bytes_to_i16};

const ENDPOINT: &str = "wss://api.stepfun.com/v1/realtime";

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone, Debug)]
pub struct Setup {
    pub model: String,
    pub voice: String,
    pub system_instruction: String,
    /// Flat `{name, description, parameters}` declarations; wrapped in StepFun's function envelope.
    pub functions: Vec<Value>,
    /// Owner-supplied session fields (the `realtime_config` setting), merged over the defaults.
    pub overrides: Value,
}

/// Deep-merges `over` into `base`: objects merge key by key, anything else replaces.
/// `tools` is appended instead, so owner tools add to ask_hermes/end_call.
fn merge(base: &mut Value, over: &Value) {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            for (key, value) in o {
                match (key.as_str(), b.get_mut(key)) {
                    ("tools", Some(Value::Array(existing))) if value.is_array() => {
                        existing.extend(value.as_array().unwrap().iter().cloned())
                    }
                    (_, Some(slot)) => merge(slot, value),
                    (_, None) => {
                        b.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (slot, value) => *slot = value.clone(),
    }
}

impl Setup {
    fn session(&self) -> Value {
        let mut session = json!({
            "modalities": ["text", "audio"],
            "instructions": self.system_instruction,
            "voice": self.voice,
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "turn_detection": {
                "type": "server_vad",
                "prefix_padding_ms": 300,
                "silence_duration_ms": 600,
            },
        });
        if !self.functions.is_empty() {
            session["tools"] = self
                .functions
                .iter()
                .map(|f| {
                    if f.get("type").is_some() {
                        f.clone()
                    } else {
                        json!({"type": "function", "function": f})
                    }
                })
                .collect();
        }
        merge(&mut session, &self.overrides);
        json!({"type": "session.update", "session": session})
    }
}

#[derive(Debug, PartialEq)]
pub enum LiveEvent {
    /// Model speech, 24 kHz mono.
    Audio(Vec<i16>),
    /// The caller started talking; drop queued speech.
    Interrupted,
    InputTranscript(String),
    OutputTranscript(String),
    ToolCall {
        id: String,
        name: String,
        args: Value,
    },
    ToolCancelled(Vec<String>),
    /// The session ended for good; carries the reason.
    Closed(String),
}

#[derive(Debug, Default, PartialEq)]
struct Parsed {
    events: Vec<LiveEvent>,
    /// Ask the server to stop generating (caller barged in).
    cancel: bool,
}

/// Turns server events into `LiveEvent`s, holding the state the wire protocol leaves implicit.
#[derive(Default)]
struct Parser {
    response_active: bool,
    cancel_sent: bool,
    /// Input ASR deltas are cumulative per item, so only the new suffix is emitted.
    heard: HashMap<String, String>,
    /// Items whose final transcription was already emitted.
    completed: HashSet<String>,
    /// Function calls emitted but not answered yet; cancelled when the caller barges in.
    pending_tools: HashSet<String>,
    seen_calls: HashSet<String>,
    /// A delta can end mid-sample; hold the byte until the next one.
    audio_leftover: Vec<u8>,
}

impl Parser {
    fn parse(&mut self, msg: &Value) -> Parsed {
        let mut p = Parsed::default();
        let kind = msg["type"].as_str().unwrap_or_default();
        match kind {
            "response.created" => {
                self.response_active = true;
                self.cancel_sent = false;
            }
            "response.done" | "response.cancelled" => {
                self.response_active = false;
                self.cancel_sent = false;
            }
            "input_audio_buffer.speech_started" => {
                p.events.push(LiveEvent::Interrupted);
                if self.response_active && !self.cancel_sent {
                    self.cancel_sent = true;
                    p.cancel = true;
                    if !self.pending_tools.is_empty() {
                        p.events
                            .push(LiveEvent::ToolCancelled(self.pending_tools.drain().collect()));
                    }
                }
            }
            "conversation.item.input_audio_transcription.delta" => {
                let item = msg["item_id"].as_str().unwrap_or_default();
                let next = msg["delta"].as_str().unwrap_or_default();
                let prev = self.heard.get(item).cloned().unwrap_or_default();
                let add = if let Some(rest) = next.strip_prefix(prev.as_str()) {
                    rest.to_string()
                } else if prev.starts_with(next) {
                    String::new()
                } else {
                    next.to_string()
                };
                if !add.is_empty() {
                    p.events.push(LiveEvent::InputTranscript(add));
                }
                self.heard.insert(item.to_string(), next.to_string());
            }
            "conversation.item.input_audio_transcription.completed" => {
                let item = msg["item_id"].as_str().unwrap_or_default();
                if item.is_empty() || self.completed.insert(item.to_string()) {
                    let full = msg["transcript"].as_str().unwrap_or_default();
                    let prev = self.heard.remove(item).unwrap_or_default();
                    let rest = full.strip_prefix(prev.as_str()).unwrap_or(full);
                    if !rest.is_empty() {
                        p.events.push(LiveEvent::InputTranscript(rest.to_string()));
                    }
                }
            }
            "response.audio_transcript.delta" => {
                if let Some(t) = msg["delta"].as_str().filter(|t| !t.is_empty()) {
                    p.events.push(LiveEvent::OutputTranscript(t.to_string()));
                }
            }
            "response.audio.delta" => {
                if let Some(data) = msg["delta"].as_str()
                    && let Ok(mut bytes) = B64.decode(data)
                {
                    if !self.audio_leftover.is_empty() {
                        let mut joined = std::mem::take(&mut self.audio_leftover);
                        joined.append(&mut bytes);
                        bytes = joined;
                    }
                    let even = bytes.len() - bytes.len() % 2;
                    if even > 0 {
                        p.events.push(LiveEvent::Audio(le_bytes_to_i16(&bytes[..even])));
                    }
                    self.audio_leftover = bytes[even..].to_vec();
                }
            }
            "response.function_call_arguments.done" => {
                let id = msg["call_id"].as_str().unwrap_or_default();
                let name = msg["name"].as_str().unwrap_or_default();
                if !id.is_empty() && !name.is_empty() && self.seen_calls.insert(id.to_string()) {
                    self.pending_tools.insert(id.to_string());
                    p.events.push(LiveEvent::ToolCall {
                        id: id.to_string(),
                        name: name.to_string(),
                        args: parse_args(&msg["arguments"]),
                    });
                }
            }
            // Not every tool call produces an arguments.done event; the completed item carries the
            // same fields, so use it as a fallback (deduped by call_id).
            "response.output_item.done" => {
                let item = &msg["item"];
                if item["type"].as_str() == Some("function_call") {
                    let id = item["call_id"].as_str().unwrap_or_default();
                    let name = item["name"].as_str().unwrap_or_default();
                    if !id.is_empty() && !name.is_empty() && self.seen_calls.insert(id.to_string()) {
                        self.pending_tools.insert(id.to_string());
                        p.events.push(LiveEvent::ToolCall {
                            id: id.to_string(),
                            name: name.to_string(),
                            args: parse_args(&item["arguments"]),
                        });
                    }
                }
            }
            "error" => log::warn!("stepfun: {}", error_message(msg)),
            _ => {}
        }
        p
    }
}

fn parse_args(value: &Value) -> Value {
    match value {
        Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
        Value::Null => json!({}),
        other => other.clone(),
    }
}

fn error_message(msg: &Value) -> String {
    msg["error"]["message"]
        .as_str()
        .or(msg["message"].as_str())
        .unwrap_or("unknown error")
        .to_string()
}

enum Outgoing {
    /// Base64 append event, formatted once on the caller's thread.
    Audio(String),
    /// Sent immediately, order preserved.
    Event(Value),
    /// A conversation item that must be followed by a response.
    Prompt(Value),
    /// Trigger a response once any active one finishes.
    Respond,
}

pub struct Live {
    outbox: mpsc::UnboundedSender<Outgoing>,
    pub events: mpsc::UnboundedReceiver<LiveEvent>,
    task: JoinHandle<()>,
}

impl Live {
    pub async fn connect(api_key: &str, setup: Setup) -> Result<Self> {
        let ws = open(api_key, &setup).await?;
        let (outbox, out_rx) = mpsc::unbounded_channel();
        let (ev_tx, events) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(ws, out_rx, ev_tx));
        Ok(Self {
            outbox,
            events,
            task,
        })
    }

    /// 24 kHz mono caller audio (upsampled from the call's 16 kHz).
    pub fn send_audio(&self, pcm: &[i16]) {
        if pcm.is_empty() {
            return;
        }
        let msg = json!({
            "type": "input_audio_buffer.append",
            "audio": B64.encode(i16_to_le_bytes(pcm)),
        });
        let _ = self.outbox.send(Outgoing::Audio(msg.to_string()));
    }

    pub fn send_text(&self, text: &str) {
        let item = json!({"type": "conversation.item.create", "item": {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": text}],
        }});
        let _ = self.outbox.send(Outgoing::Prompt(item));
    }

    /// `scheduling` is kept from the Gemini-style call sites: "SILENT" answers the function call
    /// without asking the model to speak again.
    pub fn send_tool_response(&self, id: &str, response: Value, scheduling: &str) {
        let output = match response {
            Value::String(s) => s,
            other => other.to_string(),
        };
        let item = json!({"type": "conversation.item.create", "item": {
            "type": "function_call_output",
            "call_id": id,
            "output": output,
        }});
        let _ = self.outbox.send(Outgoing::Event(item));
        if scheduling != "SILENT" {
            let _ = self.outbox.send(Outgoing::Respond);
        }
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn open(api_key: &str, setup: &Setup) -> Result<Ws> {
    let url = format!("{ENDPOINT}?model={}", query_escape(&setup.model));
    let mut req = url.into_client_request()?;
    req.headers_mut()
        .insert("Authorization", format!("Bearer {api_key}").parse()?);
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(req),
    )
    .await
    .context("timed out connecting to StepFun Realtime")?
    .context("connecting to StepFun Realtime")?;
    ws.send(Message::text(setup.session().to_string()))
        .await?;
    let ready = async {
        while let Some(frame) = ws.next().await {
            let value = match frame? {
                Message::Text(t) => serde_json::from_str::<Value>(&t),
                Message::Binary(b) => serde_json::from_slice::<Value>(&b),
                Message::Close(c) => bail!("StepFun closed during setup: {c:?}"),
                _ => continue,
            };
            let Ok(value) = value else { continue };
            match value["type"].as_str() {
                Some("session.updated") => return Ok(()),
                Some("error") => bail!("StepFun rejected the session: {}", error_message(&value)),
                _ => {}
            }
        }
        Err(anyhow!("StepFun closed during setup"))
    };
    tokio::time::timeout(Duration::from_secs(15), ready)
        .await
        .context("timed out waiting for StepFun session")??;
    Ok(ws)
}

fn query_escape(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn send(ws: &mut Ws, msg: &Value) -> Result<()> {
    ws.send(Message::text(msg.to_string()))
        .await
        .context("sending to StepFun")
}

async fn run(
    mut ws: Ws,
    mut out_rx: mpsc::UnboundedReceiver<Outgoing>,
    ev_tx: mpsc::UnboundedSender<LiveEvent>,
) {
    let mut parser = Parser::default();
    let mut want_response = false;
    loop {
        tokio::select! {
            out = out_rx.recv() => match out {
                Some(Outgoing::Audio(text)) => {
                    if let Err(e) = ws.send(Message::text(text)).await {
                        let _ = ev_tx.send(LiveEvent::Closed(format!("send failed: {e}")));
                        return;
                    }
                }
                Some(Outgoing::Event(msg)) => {
                    if let Err(e) = send(&mut ws, &msg).await {
                        let _ = ev_tx.send(LiveEvent::Closed(e.to_string()));
                        return;
                    }
                }
                Some(Outgoing::Prompt(msg)) => {
                    if let Err(e) = send(&mut ws, &msg).await {
                        let _ = ev_tx.send(LiveEvent::Closed(e.to_string()));
                        return;
                    }
                    want_response = true;
                }
                Some(Outgoing::Respond) => want_response = true,
                None => {
                    let _ = ws.close(None).await;
                    return;
                }
            },
            frame = ws.next() => {
                let value = match frame {
                    Some(Ok(Message::Text(t))) => serde_json::from_str::<Value>(&t),
                    Some(Ok(Message::Binary(b))) => serde_json::from_slice::<Value>(&b),
                    Some(Ok(Message::Close(c))) => {
                        let _ = ev_tx.send(LiveEvent::Closed(format!("closed: {c:?}")));
                        return;
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => {
                        let _ = ev_tx.send(LiveEvent::Closed(format!("socket error: {e}")));
                        return;
                    }
                    None => {
                        let _ = ev_tx.send(LiveEvent::Closed("socket ended".into()));
                        return;
                    }
                };
                let Ok(value) = value else { continue };
                let parsed = parser.parse(&value);
                if parsed.cancel && send(&mut ws, &json!({"type": "response.cancel"})).await.is_err() {
                    let _ = ev_tx.send(LiveEvent::Closed("send failed".into()));
                    return;
                }
                for ev in parsed.events {
                    if ev_tx.send(ev).is_err() {
                        return;
                    }
                }
            }
        }
        if want_response && !parser.response_active {
            if let Err(e) = send(&mut ws, &json!({"type": "response.create"})).await {
                let _ = ev_tx.send(LiveEvent::Closed(e.to_string()));
                return;
            }
            want_response = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Setup {
        Setup {
            model: "stepaudio-3-realtime-preview".into(),
            voice: "jingdiannvsheng".into(),
            system_instruction: "be brief".into(),
            functions: vec![json!({"name": "end_call"})],
            overrides: json!({}),
        }
    }

    #[test]
    fn session_message_shape() {
        let m = setup().session();
        assert_eq!(m["type"], "session.update");
        let s = &m["session"];
        assert_eq!(s["modalities"], json!(["text", "audio"]));
        assert_eq!(s["voice"], "jingdiannvsheng");
        assert_eq!(s["input_audio_format"], "pcm16");
        assert_eq!(s["output_audio_format"], "pcm16");
        assert_eq!(s["turn_detection"]["type"], "server_vad");
        assert_eq!(s["tools"][0]["type"], "function");
        assert_eq!(s["tools"][0]["function"]["name"], "end_call");
    }

    #[test]
    fn realtime_config_overrides_merge() {
        let mut s = setup();
        s.overrides = json!({
            "turn_detection": {"silence_duration_ms": 900, "energy_awakeness_threshold": 1800},
            "instructions": "be very brief",
            "tools": [{"type": "web_search"}],
        });
        let m = s.session();
        let session = &m["session"];
        assert_eq!(session["instructions"], "be very brief");
        assert_eq!(session["turn_detection"]["silence_duration_ms"], 900);
        assert_eq!(session["turn_detection"]["type"], "server_vad");
        assert_eq!(session["tools"][0]["function"]["name"], "end_call");
        assert_eq!(session["tools"][1]["type"], "web_search");
    }

    #[test]
    fn parses_audio_and_output_transcript() {
        let pcm = B64.encode(i16_to_le_bytes(&[1, -2, 3]));
        let mut parser = Parser::default();
        let p = parser.parse(&json!({"type": "response.audio.delta", "delta": pcm}));
        assert_eq!(p.events, vec![LiveEvent::Audio(vec![1, -2, 3])]);
        let p = parser.parse(&json!({"type": "response.audio_transcript.delta", "delta": "hel"}));
        assert_eq!(p.events, vec![LiveEvent::OutputTranscript("hel".into())]);
    }

    #[test]
    fn input_transcript_deltas_are_cumulative() {
        let mut parser = Parser::default();
        let mut feed = |text: &str| {
            parser
                .parse(&json!({
                    "type": "conversation.item.input_audio_transcription.delta",
                    "item_id": "i1",
                    "delta": text,
                }))
                .events
        };
        assert_eq!(feed(""), vec![]);
        assert_eq!(feed("hel"), vec![LiveEvent::InputTranscript("hel".into())]);
        assert_eq!(feed("hello"), vec![LiveEvent::InputTranscript("lo".into())]);
        assert_eq!(feed("hello"), vec![]);
        let done = parser.parse(&json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "i1",
            "transcript": "hello there",
        }));
        assert_eq!(
            done.events,
            vec![LiveEvent::InputTranscript(" there".into())]
        );
    }

    #[test]
    fn completed_transcript_without_deltas_is_emitted_once() {
        let mut parser = Parser::default();
        let msg = json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "i1",
            "transcript": "hi",
        });
        assert_eq!(
            parser.parse(&msg).events,
            vec![LiveEvent::InputTranscript("hi".into())]
        );
        assert_eq!(parser.parse(&msg).events, vec![]);
    }

    #[test]
    fn emits_tool_calls_once_and_tracks_pending() {
        let mut parser = Parser::default();
        let msg = json!({
            "type": "response.function_call_arguments.done",
            "call_id": "c1",
            "name": "ask_hermes",
            "arguments": "{\"request\":\"x\"}",
        });
        assert_eq!(
            parser.parse(&msg).events,
            vec![LiveEvent::ToolCall {
                id: "c1".into(),
                name: "ask_hermes".into(),
                args: json!({"request": "x"}),
            }]
        );
        assert_eq!(parser.parse(&msg).events, vec![], "deduped");
        assert!(parser.pending_tools.contains("c1"));
    }

    #[test]
    fn barge_in_cancels_an_active_response_and_its_pending_tools() {
        let mut parser = Parser::default();
        parser.parse(&json!({"type": "response.created"}));
        parser.parse(&json!({
            "type": "response.function_call_arguments.done",
            "call_id": "c1",
            "name": "ask_hermes",
            "arguments": "{}",
        }));
        let p = parser.parse(&json!({"type": "input_audio_buffer.speech_started"}));
        assert!(p.cancel);
        assert_eq!(
            p.events,
            vec![
                LiveEvent::Interrupted,
                LiveEvent::ToolCancelled(vec!["c1".into()]),
            ]
        );
        parser.parse(&json!({"type": "response.done"}));
        let p = parser.parse(&json!({"type": "input_audio_buffer.speech_started"}));
        assert!(!p.cancel, "nothing left to cancel");
        assert_eq!(p.events, vec![LiveEvent::Interrupted]);
    }

    #[test]
    fn ignores_benign_errors() {
        let mut parser = Parser::default();
        let p = parser.parse(&json!({"type": "error", "error": {"message": "nothing to cancel"}}));
        assert!(p.events.is_empty());
    }

    #[test]
    fn escapes_the_model_in_the_query() {
        assert_eq!(query_escape("stepaudio-3-realtime-preview"), "stepaudio-3-realtime-preview");
        assert_eq!(query_escape("a b&c"), "a%20b%26c");
    }

    /// Live check against the real API: `STEPFUN_API_KEY=... cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_round_trip() {
        let key = std::env::var("STEPFUN_API_KEY").expect("STEPFUN_API_KEY");
        let mut setup = Setup {
            model: std::env::var("HWV_MODEL")
                .unwrap_or_else(|_| "stepaudio-3-realtime-preview".into()),
            voice: std::env::var("HWV_VOICE").unwrap_or_else(|_| "jingdiannvsheng".into()),
            system_instruction: "Answer in one short sentence.".into(),
            functions: vec![json!({"name": "end_call", "description": "Hang up."})],
            overrides: json!({}),
        };
        if let Ok(raw) = std::env::var("HWV_REALTIME_CONFIG") {
            setup.overrides = serde_json::from_str(&raw).expect("HWV_REALTIME_CONFIG JSON");
        }
        let mut live = Live::connect(&key, setup).await.expect("connect");
        live.send_text("Say hello.");
        let (mut audio, mut transcript) = (0usize, String::new());
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while audio < 24_000 || transcript.is_empty() {
            match tokio::time::timeout_at(deadline, live.events.recv()).await {
                Ok(Some(LiveEvent::Audio(pcm))) => audio += pcm.len(),
                Ok(Some(LiveEvent::OutputTranscript(t))) => transcript.push_str(&t),
                Ok(Some(LiveEvent::Closed(why))) => panic!("closed: {why}"),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        println!("audio samples: {audio}, transcript: {transcript:?}");
        assert!(
            audio >= 24_000,
            "expected at least 1s of speech, got {audio} samples"
        );
    }

    /// Live tool check (`--ignored live_tool`): the model calls a function, gets its output, and
    /// speaks the answer, which exercises the same path as `ask_hermes`.
    #[tokio::test]
    #[ignore]
    async fn live_tool_round_trip() {
        let key = std::env::var("STEPFUN_API_KEY").expect("STEPFUN_API_KEY");
        let setup = Setup {
            model: std::env::var("HWV_MODEL")
                .unwrap_or_else(|_| "stepaudio-3-realtime-preview".into()),
            voice: std::env::var("HWV_VOICE").unwrap_or_else(|_| "jingdiannvsheng".into()),
            system_instruction: "You must call the get_secret_word tool whenever a secret word is \
                requested, then tell the caller the word the tool returned."
                .into(),
            functions: vec![json!({
                "name": "get_secret_word",
                "description": "Return the secret word.",
                "parameters": {"type": "object", "properties": {}},
            })],
            overrides: json!({}),
        };
        let mut live = Live::connect(&key, setup).await.expect("connect");
        live.send_text("What is the secret word? Call the get_secret_word tool.");
        let mut transcript = String::new();
        let mut called = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
        while !(called && transcript.to_lowercase().contains("pineapple")) {
            match tokio::time::timeout_at(deadline, live.events.recv()).await {
                Ok(Some(LiveEvent::ToolCall { id, name, .. })) => {
                    assert_eq!(name, "get_secret_word");
                    called = true;
                    live.send_tool_response(&id, json!({"word": "pineapple"}), "WHEN_IDLE");
                }
                Ok(Some(LiveEvent::OutputTranscript(t))) => transcript.push_str(&t),
                Ok(Some(LiveEvent::Closed(why))) => panic!("closed: {why}"),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        println!("tool called: {called}, transcript: {transcript:?}");
        assert!(called, "the model never called the tool");
        assert!(
            transcript.to_lowercase().contains("pineapple"),
            "the spoken reply did not use the tool output: {transcript:?}"
        );
    }
}

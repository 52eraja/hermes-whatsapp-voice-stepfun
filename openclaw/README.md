# WhatsApp Voice for OpenClaw (StepFun)

Place real WhatsApp voice calls to the owner from an OpenClaw agent. The speech is StepFun
StepAudio 3 Realtime (speech-to-speech), and the voice on the call can hand real work back to the
OpenClaw agent mid-call.

This is the OpenClaw port of
[`hermes-whatsapp-voice-stepfun`](https://github.com/52eraja/hermes-whatsapp-voice-stepfun). The Rust
sidecar is the same one the Hermes plugin uses, byte for byte.

## How it works

```
OpenClaw agent  --whatsapp_call_owner-->  plugin  --HTTP-->  sidecar  --VoIP-->  WhatsApp
                                                                            |
                                                          StepFun StepAudio 3 Realtime
                                                                            |
                                          plugin's /v1/runs bridge <------+
                                          (the voice asks the agent for real work)
```

- The **sidecar** (`hermes-wa-voice`, Rust) owns the WhatsApp linked-device session, places and
  answers calls, and streams audio to StepFun.
- The **plugin** (TypeScript) starts the sidecar, exposes two agent tools, and serves a small
  loopback `/v1/runs` bridge so the voice on a call can ask the OpenClaw agent to do things.

## Install

```bash
openclaw plugins install npm:openclaw-whatsapp-voice-stepfun
openclaw whatsapp-voice install     # downloads and verifies the sidecar binary
```

Then set your number and pair the bot's WhatsApp number — the full runbook is in the bundled skill
`whatsapp-voice-stepfun`, and `openclaw whatsapp-voice --help` lists the commands:

| Command | What it does |
|---|---|
| `openclaw whatsapp-voice install` | Download the pinned sidecar binary and verify its SHA-256. `--from-source` builds it with Rust instead. |
| `openclaw whatsapp-voice pair` | Link the sidecar to the bot's WhatsApp number (QR code, or `--phone <number>` for a pair code). |
| `openclaw whatsapp-voice serve` | Run the sidecar in the foreground. |
| `openclaw whatsapp-voice service` | Print a systemd unit (Linux), launchd plist (macOS) or PowerShell scheduled task (Windows) that keeps the sidecar running. |
| `openclaw whatsapp-voice status` | Sidecar health: linked, version, active call. |
| `openclaw whatsapp-voice call "reason"` | Place a test call to the owner. |

## Configuration

Everything lives under `plugins.entries.whatsapp-voice-stepfun.config`:

| Key | Default | Meaning |
|---|---|---|
| `ownerNumber` | – | Your WhatsApp number in international format. The only number called, and the only caller answered. |
| `voiceModel` | `stepaudio-3-realtime-preview` | StepFun Realtime model id. |
| `voice` | `jingdiannvsheng` | StepFun voice id. |
| `assistantName` | `OpenClaw` | Fallback name when the agent gives no persona briefing. |
| `languages` | – | Comma-separated language codes the voice may use, e.g. `en-US,ta-IN`. |
| `voiceInstructions` | – | Your own rules for the voice: language, tone, call length. |
| `ringTimeoutSeconds` | `45` | How long an outgoing call rings before it counts as unanswered. |
| `maxCallMinutes` | `15` | Automatic call length cap (StepFun caps sessions at 30 minutes). |
| `silenceHangupSeconds` | `180` | Hangs up after this much silence, e.g. left on hold. |
| `answerInbound` | `true` | Answer when the owner's number calls the bot. |
| `sendSummary` | `true` | Send a short WhatsApp summary after each call. |
| `realtimeConfig` | `{}` | Any StepFun Realtime session field, merged over the defaults. |
| `stepfunApiKey` | `STEPFUN_API_KEY` env | StepFun API key. Prefer the environment variable. |
| `agentId` | default agent | Which OpenClaw agent the voice consults during a call. |
| `autoStart` | `true` | Start the sidecar on demand when a call is requested. |
| `listen` | `127.0.0.1:8796` | Loopback address of the sidecar's local API. |
| `consultListen` | `127.0.0.1:8797` | Loopback address the plugin's agent bridge listens on. |

## Agent tools

| Tool | What it does |
|---|---|
| `whatsapp_call_owner` | Calls the owner and talks to them with the realtime voice agent. Returns the transcript once the call ends. |
| `whatsapp_call_status` | Reads one call by id, or lists the most recent calls with their transcripts. |

## Security

- The sidecar only ever calls `ownerNumber`, and only answers that number.
- The sidecar's HTTP API and the plugin's agent bridge listen on loopback only and require a bearer
  token that is generated on first use and stored with owner-only permissions.
- The StepFun API key is handed to the sidecar through the process environment. It is never written
  to disk by the plugin.

## Development

```bash
npm install
npm run build          # tsc
npm test               # vitest
npm run plugin:validate
```

The sidecar sources live in `../sidecar` in this repository; `openclaw whatsapp-voice install
--from-source` builds them from there.

## License

MIT. See [LICENSE](LICENSE).

//! Configuration from the environment. `hermes whatsapp-voice serve` fills it from the plugin's
//! settings and Hermes secrets.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};

#[derive(Clone, Debug)]
pub struct Config {
    /// Owner's phone number, digits only.
    pub owner: String,
    pub listen: String,
    pub token: String,
    pub stepfun_api_key: String,
    pub model: String,
    pub voice: String,
    pub assistant_name: String,
    /// The owner's own extra rules for the voice (style, language, call length).
    pub voice_instructions: String,
    /// Language codes (e.g. en-US) the voice may use; empty means any.
    pub languages: Vec<String>,
    /// Raw StepFun Realtime session fields (JSON object) merged over the defaults.
    pub realtime_config: serde_json::Value,
    pub hermes_api_url: String,
    /// Empty disables ask_hermes.
    pub hermes_api_key: String,
    pub ring_timeout: Duration,
    pub max_duration: Duration,
    /// End a call after this long with nobody speaking.
    pub silence_timeout: Duration,
    pub answer_inbound: bool,
    pub send_summary: bool,
}

fn var(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn required(name: &str) -> Result<String> {
    let v = var(name, "");
    if v.is_empty() {
        bail!("{name} is not set");
    }
    Ok(v)
}

/// Parses "45s", "15m", "1h" or plain seconds.
pub fn parse_duration(s: &str) -> Result<Duration> {
    let s = s.trim();
    if s.trim_start_matches('0')
        .trim_end_matches(['s', 'm', 'h'])
        .is_empty()
    {
        bail!("duration {s:?} must be more than zero");
    }
    let (num, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len()));
    let n: u64 = num.parse().with_context(|| format!("bad duration {s:?}"))?;
    let secs = match unit {
        "" | "s" => n,
        "m" => n * 60,
        "h" => n * 3600,
        _ => bail!("bad duration unit in {s:?}"),
    };
    Ok(Duration::from_secs(secs))
}

fn realtime_config(raw: &str) -> Result<serde_json::Value> {
    let value: serde_json::Value =
        serde_json::from_str(raw).context("realtime_config is not valid JSON")?;
    if !value.is_object() {
        bail!("realtime_config must be a JSON object of StepFun Realtime session fields");
    }
    Ok(value)
}

pub fn digits(number: &str) -> String {
    number.chars().filter(char::is_ascii_digit).collect()
}

impl Config {
    /// Settings needed by both `pair` and `serve`.
    pub fn data_dir() -> Result<PathBuf> {
        Ok(PathBuf::from(required("HWV_DATA_DIR")?))
    }

    pub fn from_env() -> Result<Self> {
        let owner = digits(&required("HWV_OWNER")?);
        let listen = var("HWV_LISTEN", "127.0.0.1:8796");
        // The API's bearer token travels over plain HTTP, so it must never leave this machine.
        if !listen
            .parse::<std::net::SocketAddr>()
            .is_ok_and(|a| a.ip().is_loopback())
        {
            bail!("HWV_LISTEN must be a loopback address like 127.0.0.1:8796, got {listen:?}");
        }
        if owner.len() < 7 {
            bail!("HWV_OWNER must be a full international phone number");
        }
        Ok(Self {
            owner,
            listen,
            token: required("HWV_TOKEN")?,
            stepfun_api_key: required("STEPFUN_API_KEY")?,
            model: var("HWV_MODEL", "stepaudio-3-realtime-preview"),
            voice: var("HWV_VOICE", "jingdiannvsheng"),
            assistant_name: var("HWV_ASSISTANT_NAME", "Hermes"),
            voice_instructions: var("HWV_VOICE_INSTRUCTIONS", ""),
            languages: var("HWV_LANGUAGES", "")
                .split(',')
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect(),
            realtime_config: realtime_config(&var("HWV_REALTIME_CONFIG", "{}"))?,
            hermes_api_url: var("HERMES_API_URL", "http://127.0.0.1:8642")
                .trim_end_matches('/')
                .to_string(),
            hermes_api_key: var("HERMES_API_KEY", ""),
            ring_timeout: parse_duration(&var("HWV_RING_TIMEOUT", "45s"))?,
            max_duration: parse_duration(&var("HWV_MAX_DURATION", "15m"))?,
            silence_timeout: parse_duration(&var("HWV_SILENCE_TIMEOUT", "180s"))?,
            answer_inbound: var("HWV_ANSWER_INBOUND", "true") == "true",
            send_summary: var("HWV_SEND_SUMMARY", "true") == "true",
        })
    }

    pub fn store_path(data_dir: &std::path::Path) -> String {
        data_dir.join("whatsapp.db").to_string_lossy().into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(parse_duration("45s").unwrap(), Duration::from_secs(45));
        assert_eq!(parse_duration("15m").unwrap(), Duration::from_secs(900));
        assert_eq!(parse_duration("90").unwrap(), Duration::from_secs(90));
        assert!(parse_duration("5x").is_err());
        assert!(parse_duration("0m").is_err());
        assert!(parse_duration("0").is_err());
    }

    #[test]
    fn realtime_config_must_be_an_object() {
        assert_eq!(realtime_config("{}").unwrap(), serde_json::json!({}));
        assert!(realtime_config("[1]").is_err());
        assert!(realtime_config("{bad").is_err());
    }

    #[test]
    fn owner_digits() {
        assert_eq!(digits("+1 (555) 123-4567"), "15551234567");
    }
}

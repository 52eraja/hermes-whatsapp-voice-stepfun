//! Hermes API server client (`/v1/runs`): how the voice agent hands real work to Hermes.

use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

const TERMINAL: [&str; 4] = ["completed", "failed", "cancelled", "interrupted"];

#[derive(Clone)]
pub struct Hermes {
    http: reqwest::Client,
    base: String,
    key: String,
}

impl Hermes {
    pub fn new(base: &str, key: &str) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("http client"),
            base: base.to_string(),
            key: key.to_string(),
        }
    }

    /// Start a run and wait for its final answer.
    pub async fn run(
        &self,
        input: &str,
        instructions: &str,
        session_id: &str,
        timeout: Duration,
    ) -> Result<String> {
        let started: Value = self
            .http
            .post(format!("{}/v1/runs", self.base))
            .bearer_auth(&self.key)
            .json(&json!({"input": input, "instructions": instructions, "session_id": session_id}))
            .send()
            .await
            .context("Hermes API server unreachable")?
            .error_for_status()
            .context("Hermes rejected the run")?
            .json()
            .await?;
        let run_id = started["run_id"]
            .as_str()
            .context("no run_id in response")?
            .to_string();

        let deadline = Instant::now() + timeout;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let run: Value = self
                .http
                .get(format!("{}/v1/runs/{run_id}", self.base))
                .bearer_auth(&self.key)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            let status = run["status"].as_str().unwrap_or("unknown");
            if TERMINAL.contains(&status) {
                if status != "completed" {
                    bail!("Hermes run {status}: {}", run["error"]);
                }
                return Ok(run["output"].as_str().unwrap_or_default().to_string());
            }
            if Instant::now() >= deadline {
                let _ = self
                    .http
                    .post(format!("{}/v1/runs/{run_id}/stop", self.base))
                    .bearer_auth(&self.key)
                    .send()
                    .await;
                bail!("Hermes did not finish within {}s", timeout.as_secs());
            }
        }
    }
}

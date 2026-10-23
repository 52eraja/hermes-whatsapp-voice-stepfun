import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN_ID = "whatsapp-voice-stepfun";

/** OpenClaw's config home. `OPENCLAW_CONFIG_DIR` wins so tests can point elsewhere. */
export function configDir(): string {
  const fromEnv = process.env.OPENCLAW_CONFIG_DIR?.trim();
  return fromEnv || join(homedir(), ".openclaw");
}

/** Holds the WhatsApp session, the sidecar binary and the shared secrets. */
export function dataDir(): string {
  const dir = join(configDir(), "plugins", PLUGIN_ID);
  mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    chmodSync(dir, 0o700);
  }
  return dir;
}

export function binaryName(): string {
  return process.platform === "win32" ? "hermes-wa-voice.exe" : "hermes-wa-voice";
}

export function binaryPath(): string {
  return join(dataDir(), "bin", binaryName());
}

/** Shared secret between the plugin and the sidecar's own HTTP API. */
export function sidecarTokenPath(): string {
  return join(dataDir(), "sidecar.token");
}

/** Shared secret between the plugin's consult bridge and the sidecar's ask-agent tool. */
export function consultTokenPath(): string {
  return join(dataDir(), "consult.token");
}

export function sidecarLogPath(): string {
  return join(dataDir(), "sidecar.log");
}

export function sidecarPidPath(): string {
  return join(dataDir(), "sidecar.pid");
}

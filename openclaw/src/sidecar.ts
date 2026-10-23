import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SidecarError } from "./client.js";
import type { ResolvedSettings } from "./config.js";
import {
  binaryName,
  binaryPath,
  consultTokenPath,
  dataDir,
  sidecarLogPath,
  sidecarPidPath,
  sidecarTokenPath,
} from "./paths.js";
import { sidecarRelease } from "./release.js";

export { SidecarError };

/** Release asset for the running platform. */
const ASSETS: Record<string, string> = {
  "linux-x64": "hermes-wa-voice_linux_amd64",
  "linux-arm64": "hermes-wa-voice_linux_arm64",
  "darwin-x64": "hermes-wa-voice_darwin_amd64",
  "darwin-arm64": "hermes-wa-voice_darwin_arm64",
  "win32-x64": "hermes-wa-voice_windows_amd64.exe",
  "win32-arm64": "hermes-wa-voice_windows_arm64.exe",
};

export function assetName(platform = process.platform, arch = process.arch): string {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) {
    throw new SidecarError(
      `No prebuilt sidecar for ${platform}/${arch}. Build it from source with \`openclaw whatsapp-voice install --from-source\`.`,
    );
  }
  return asset;
}

export function readOrCreateToken(path: string): string {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) {
      return existing;
    }
  } catch {
    // Not created yet.
  }
  const value = randomBytes(32).toString("base64url");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { mode: 0o600 });
  return value;
}

export function sidecarToken(): string {
  return readOrCreateToken(sidecarTokenPath());
}

export function consultToken(): string {
  return readOrCreateToken(consultTokenPath());
}

function ghLoggedIn(): boolean {
  const probe = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
  return probe.status === 0;
}

/**
 * Fetch the pinned release binary and refuse to install anything whose sha256 does not match
 * the checksum committed next to this plugin.
 */
export async function downloadRelease(dest: string): Promise<void> {
  const release = sidecarRelease();
  const asset = assetName();
  const expected = release.checksums[asset];
  if (!expected) {
    throw new SidecarError(`No pinned checksum for ${asset}; build the sidecar with --from-source.`);
  }
  const url = `https://github.com/${release.repo}/releases/download/${release.tag}/${asset}`;
  process.stdout.write(`Downloading ${asset} from the ${release.tag} release of ${release.repo} ...\n`);
  let bytes: Buffer;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SidecarError(
      `Could not download the ${release.tag} release (${reason}); build the sidecar with \`openclaw whatsapp-voice install --from-source\`.`,
    );
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new SidecarError(`Checksum mismatch for ${asset}; refusing to install.`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  writeFileSync(tmp, bytes);
  if (process.platform !== "win32") {
    chmodSync(tmp, 0o755);
  }
  if (ghLoggedIn()) {
    const check = spawnSync("gh", ["attestation", "verify", tmp, "--repo", release.repo], {
      encoding: "utf8",
    });
    if (check.status !== 0) {
      throw new SidecarError(`Build attestation check failed:\n${check.stderr || check.stdout || ""}`);
    }
    process.stdout.write("Build attestation verified.\n");
  } else {
    process.stdout.write(
      `Checksum verified. With a logged-in GitHub CLI the build attestation is checked too (gh attestation verify --repo ${release.repo}).\n`,
    );
  }
  writeFileSync(dest, bytes);
  if (process.platform !== "win32") {
    chmodSync(dest, 0o755);
  }
}

/** Build the sidecar from the Rust sources that ship with the repository. */
export function buildFromSource(dest: string): void {
  const cargo = spawnSync("cargo", ["--version"], { stdio: "ignore" });
  if (cargo.status !== 0) {
    throw new SidecarError(
      "Rust is not installed (https://rustup.rs; cmake and a C compiler are also needed). Or drop --from-source to download a release build.",
    );
  }
  const src = join(fileURLToPath(new URL("../../sidecar", import.meta.url)));
  if (!existsSync(join(src, "Cargo.toml"))) {
    throw new SidecarError(
      `No Rust sources at ${src}; clone https://github.com/52eraja/hermes-whatsapp-voice-stepfun before building from source.`,
    );
  }
  process.stdout.write(`Building the sidecar from ${src} (takes a few minutes) ...\n`);
  const build = spawnSync("cargo", ["build", "--release", "--locked"], { cwd: src, stdio: "inherit" });
  if (build.status !== 0) {
    throw new SidecarError("cargo build failed.");
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(join(src, "target", "release", binaryName())));
  if (process.platform !== "win32") {
    chmodSync(dest, 0o755);
  }
}

export async function installSidecar(opts: { fromSource?: boolean } = {}): Promise<string> {
  const dest = binaryPath();
  if (opts.fromSource) {
    buildFromSource(dest);
  } else {
    await downloadRelease(dest);
  }
  return dest;
}

export function sidecarInstalled(): boolean {
  return existsSync(binaryPath());
}

/** Environment for the sidecar. The secret is handed over here, never written to disk. */
export function sidecarEnv(settings: ResolvedSettings, consultUrl: string, consultKey: string): Record<string, string> {
  return {
    HWV_OWNER: settings.ownerNumber,
    HWV_MODEL: settings.voiceModel,
    HWV_VOICE: settings.voice,
    HWV_ASSISTANT_NAME: settings.assistantName,
    HWV_LANGUAGES: settings.languages,
    HWV_VOICE_INSTRUCTIONS: settings.voiceInstructions,
    HWV_REALTIME_CONFIG: JSON.stringify(settings.realtimeConfig ?? {}),
    HWV_LISTEN: settings.listen,
    HWV_RING_TIMEOUT: `${Math.round(settings.ringTimeoutSeconds)}s`,
    HWV_MAX_DURATION: `${Math.round(settings.maxCallMinutes)}m`,
    HWV_SILENCE_TIMEOUT: `${Math.round(settings.silenceHangupSeconds)}s`,
    HWV_ANSWER_INBOUND: settings.answerInbound ? "true" : "false",
    HWV_SEND_SUMMARY: settings.sendSummary ? "true" : "false",
    HWV_DATA_DIR: dataDir(),
    HWV_TOKEN: sidecarToken(),
    STEPFUN_API_KEY: settings.stepfunApiKey,
    // The sidecar calls this the assistant endpoint: it is the /v1/runs contract the plugin serves.
    HERMES_API_URL: consultUrl,
    HERMES_API_KEY: consultKey,
  };
}

/** Start the sidecar in the background and wait until its API answers. */
export async function startSidecar(settings: ResolvedSettings, consultUrl: string, consultKey: string): Promise<void> {
  const exe = binaryPath();
  if (!existsSync(exe)) {
    throw new SidecarError("The sidecar binary is not installed. Run: openclaw whatsapp-voice install");
  }
  const env = { ...process.env, ...sidecarEnv(settings, consultUrl, consultKey) };
  const log = openSync(sidecarLogPath(), "a");
  try {
    const child = spawn(exe, ["serve"], { env, detached: true, stdio: ["ignore", log, log] });
    child.unref();
    writeFileSync(sidecarPidPath(), String(child.pid));
  } finally {
    closeSync(log);
  }
}

export function sidecarPid(): number | undefined {
  try {
    const pid = Number(readFileSync(sidecarPidPath(), "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

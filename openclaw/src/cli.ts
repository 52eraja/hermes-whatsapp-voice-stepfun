/** `openclaw whatsapp-voice ...`: install, pair, serve, service, status, call. */

import { spawn } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { SidecarClient, SidecarError } from "./client.js";
import { resolveSettings, type PluginConfig } from "./config.js";
import type { ConsultRuntime } from "./consult.js";
import { binaryPath, sidecarLogPath } from "./paths.js";
import { ensureBridge, ensureSidecar } from "./runtime.js";
import {
  consultToken,
  installSidecar,
  sidecarEnv,
  sidecarInstalled,
  sidecarToken,
  startSidecar,
} from "./sidecar.js";

type CliRegistrar = Parameters<OpenClawPluginApi["registerCli"]>[0];
type CliProgram = Parameters<CliRegistrar>[0]["program"];

export interface CliContext {
  config(): PluginConfig;
  runtime(): ConsultRuntime | null;
}

function settings(ctx: CliContext) {
  return resolveSettings(ctx.config());
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function install(ctx: CliContext, fromSource: boolean): Promise<void> {
  try {
    const dest = await installSidecar({ fromSource });
    process.stdout.write(`Installed ${dest}\nNext: openclaw whatsapp-voice pair\n`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function pair(ctx: CliContext, phone?: string): Promise<void> {
  if (!sidecarInstalled()) {
    fail("The sidecar binary is not installed. Run: openclaw whatsapp-voice install");
  }
  const s = settings(ctx);
  const env = { ...process.env, ...sidecarEnv(s, "", "") };
  const argv = [binaryPath(), "pair", ...(phone ? ["--phone", phone] : [])];
  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: "inherit" });
  await new Promise<void>((resolve) => child.on("exit", (code) => resolve()));
  process.exit(child.exitCode ?? 0);
}

async function serve(ctx: CliContext): Promise<void> {
  if (!sidecarInstalled()) {
    fail("The sidecar binary is not installed. Run: openclaw whatsapp-voice install");
  }
  const s = settings(ctx);
  if (!s.ownerNumber) {
    fail("Set your number first: openclaw config set plugins.entries.whatsapp-voice-stepfun.config.ownerNumber +15551234567");
  }
  if (!s.stepfunApiKey) {
    fail(
      "No StepFun API key found. Add STEPFUN_API_KEY to the environment (or ~/.openclaw/.env). Create one at https://platform.stepfun.com/.",
    );
  }
  const consultUrl = (await ensureBridge({ settings: s, runtime: ctx.runtime() })) ?? "";
  const env = { ...process.env, ...sidecarEnv(s, consultUrl, consultUrl ? consultToken() : "") };
  const child = spawn(binaryPath(), ["serve"], { env, stdio: "inherit" });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  process.exit(child.exitCode ?? 0);
}

function service(): void {
  const log = sidecarLogPath();
  if (process.platform === "win32") {
    process.stdout.write(`# Run this in PowerShell to keep the sidecar running after you log off:
$action  = New-ScheduledTaskAction -Execute 'openclaw.cmd' -Argument 'whatsapp-voice serve'
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'OpenClaw WhatsApp Voice' -Action $action -Trigger $trigger -Settings $settings
# The sidecar logs to:
#   ${log}
`);
    return;
  }
  if (process.platform === "darwin") {    process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<!-- Save as ~/Library/LaunchAgents/com.openclaw.whatsapp-voice.plist, then:
     launchctl load -w ~/Library/LaunchAgents/com.openclaw.whatsapp-voice.plist -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openclaw.whatsapp-voice</string>
  <key>ProgramArguments</key>
  <array><string>openclaw</string><string>whatsapp-voice</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`);
    return;
  }
  process.stdout.write(`# Save as ~/.config/systemd/user/openclaw-whatsapp-voice.service, then:
#   systemctl --user daemon-reload && systemctl --user enable --now openclaw-whatsapp-voice
#   loginctl enable-linger $USER   # keep it running while logged out
[Unit]
Description=OpenClaw WhatsApp voice sidecar
After=network-online.target

[Service]
ExecStart=openclaw whatsapp-voice serve
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`);
}

async function status(ctx: CliContext): Promise<void> {
  const s = settings(ctx);
  const client = new SidecarClient(`http://${s.listen}`, sidecarToken());
  try {
    process.stdout.write(`${JSON.stringify(await client.health(), null, 2)}\n`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function call(ctx: CliContext, reason: string): Promise<void> {
  const s = settings(ctx);
  try {
    const client = await ensureSidecar({ settings: s, runtime: ctx.runtime() });
    process.stdout.write(`${JSON.stringify(await client.startCall(reason), null, 2)}\n`);
  } catch (err) {
    fail(err instanceof SidecarError ? err.message : String(err));
  }
}

export function registerWhatsAppVoiceCli(program: CliProgram, ctx: CliContext): void {
  const command = program
    .command("whatsapp-voice")
    .description("WhatsApp voice calls: install, pair and run the sidecar");

  command
    .command("install")
    .description("Install the sidecar binary (release download, or build with Rust)")
    .option("--from-source", "Build with the local Rust toolchain")
    .action(async (options: { fromSource?: boolean }) => {
      await install(ctx, Boolean(options.fromSource));
    });

  command
    .command("pair")
    .description("Link the sidecar to your bot's WhatsApp number (shows a QR code)")
    .option("--phone <number>", "Bot's phone number, to link with a pair code instead of a QR code")
    .action(async (options: { phone?: string }) => {
      await pair(ctx, options.phone);
    });

  command
    .command("serve")
    .description("Run the sidecar in the foreground")
    .action(async () => {
      await serve(ctx);
    });

  command
    .command("service")
    .description("Print a systemd/launchd unit that keeps the sidecar running")
    .action(() => {
      service();
    });

  command
    .command("status")
    .description("Show sidecar health")
    .action(async () => {
      await status(ctx);
    });

  command
    .command("call")
    .description("Place a test call to the owner")
    .argument("[reason]", "What the call is about", "This is a quick test call.")
    .action(async (reason: string) => {
      await call(ctx, reason);
    });
}

export { startSidecar };

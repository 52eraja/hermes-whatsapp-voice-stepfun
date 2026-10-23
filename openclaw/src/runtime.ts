/** Wires the plugin's services together: the agent bridge and the sidecar it talks to. */

import { SidecarClient, SidecarError } from "./client.js";
import type { ResolvedSettings } from "./config.js";
import { ConsultBridge, type ConsultRuntime } from "./consult.js";
import { sidecarLogPath } from "./paths.js";
import { consultToken, sidecarInstalled, sidecarToken, startSidecar } from "./sidecar.js";

export interface PluginServices {
  settings: ResolvedSettings;
  runtime: ConsultRuntime | null;
}

let bridge: ConsultBridge | undefined;
let bridgeUrl: string | undefined;

/**
 * Start the agent bridge the sidecar consults during a call. The bridge lives in this process,
 * so the sidecar can only reach the OpenClaw agent while this process is alive.
 */
export async function ensureBridge(services: PluginServices): Promise<string | undefined> {
  if (!services.runtime) {
    return undefined;
  }
  if (bridgeUrl) {
    return bridgeUrl;
  }
  bridge = new ConsultBridge({
    runtime: services.runtime,
    token: consultToken(),
    agentId: services.settings.agentId || undefined,
  });
  try {
    bridgeUrl = await bridge.listen(services.settings.consultListen);
  } catch (err) {
    // The configured port can be taken; an ephemeral one still works for a sidecar we start now.
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Consult bridge could not listen on ${services.settings.consultListen} (${reason}); using a free port.\n`);
    bridgeUrl = await bridge.listen("127.0.0.1:0");
  }
  return bridgeUrl;
}

export async function closeBridge(): Promise<void> {
  await bridge?.close();
  bridge = undefined;
  bridgeUrl = undefined;
}

/** The sidecar's own HTTP API, started on demand when it is not already up. */
export async function ensureSidecar(services: PluginServices): Promise<SidecarClient> {
  const settings = services.settings;
  if (!settings.ownerNumber) {
    throw new SidecarError(
      "No owner number configured. Set plugins.entries.whatsapp-voice-stepfun.config.ownerNumber in your OpenClaw config.",
    );
  }
  if (!settings.stepfunApiKey) {
    throw new SidecarError(
      "No StepFun API key found. Set STEPFUN_API_KEY in the environment (or plugins.entries.whatsapp-voice-stepfun.config.stepfunApiKey). Create one at https://platform.stepfun.com/.",
    );
  }
  const client = new SidecarClient(`http://${settings.listen}`, sidecarToken());
  try {
    await client.health();
    return client;
  } catch {
    // Not running yet.
  }
  if (!settings.autoStart) {
    throw new SidecarError("The sidecar is not running. Start it with: openclaw whatsapp-voice serve");
  }
  if (!sidecarInstalled()) {
    throw new SidecarError("The sidecar binary is not installed. Run: openclaw whatsapp-voice install");
  }
  const consultUrl = (await ensureBridge(services)) ?? "";
  await startSidecar(settings, consultUrl, consultUrl ? consultToken() : "");
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await client.health();
      return client;
    } catch (err) {
      lastError = err;
    }
  }
  throw new SidecarError(
    `The sidecar did not come up within 30s (${lastError instanceof Error ? lastError.message : String(lastError)}). Check ${sidecarLogPath()}.`,
  );
}

/**
 * OpenClaw entry point: two agent tools (call the owner, read call status) plus the
 * `openclaw whatsapp-voice ...` CLI that installs and runs the sidecar.
 *
 * The tools are declared with `defineToolPlugin` so `openclaw plugins build` can generate
 * `openclaw.plugin.json` from this file. The CLI and the runtime lifecycle are registered
 * by the surrounding entry, which carries the same authoring metadata.
 */

import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import {
  defineToolPlugin,
  getToolPluginMetadata,
  toolPluginMetadataSymbol,
} from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";

import { registerWhatsAppVoiceCli, type CliContext } from "./cli.js";
import { configSchema, resolveSettings, type PluginConfig } from "./config.js";
import type { ConsultRuntime } from "./consult.js";
import { PLUGIN_ID } from "./paths.js";
import { closeBridge, ensureBridge, type PluginServices } from "./runtime.js";
import { callOwner, callStatus } from "./tools.js";

interface PluginHost {
  api: OpenClawPluginApi;
  runtime: PluginRuntime;
}

const hostStore = createPluginRuntimeStore<PluginHost>({
  pluginId: PLUGIN_ID,
  errorMessage: "whatsapp-voice-stepfun is not initialized yet",
});

/** The plugin's own config block, read from the live config so a reload is picked up. */
export function pluginConfigOf(config: unknown, fallback?: Record<string, unknown>): PluginConfig {
  const entries = (config as { plugins?: { entries?: Record<string, { config?: unknown }> } } | undefined)?.plugins
    ?.entries;
  const live = entries?.[PLUGIN_ID]?.config;
  if (live && typeof live === "object") {
    return live as PluginConfig;
  }
  return (fallback ?? {}) as PluginConfig;
}

function services(): PluginServices | null {
  const host = hostStore.tryGetRuntime();
  if (!host) {
    return null;
  }
  return {
    settings: resolveSettings(pluginConfigOf(host.runtime.config.current(), host.api.pluginConfig)),
    runtime: host.runtime as ConsultRuntime,
  };
}

const transcriptSchema = Type.Object(
  {
    role: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const callRecordSchema = Type.Record(Type.String(), Type.Unknown());

const callOwnerParameters = Type.Object(
  {
    reason: Type.String({
      description:
        "What the call is about, in one sentence. The voice agent reads this out to the owner, so write it for a phone call.",
    }),
    details: Type.Optional(
      Type.String({
        description: "Extra context for the voice agent, e.g. the appointment time or the order number.",
      }),
    ),
  },
  { additionalProperties: false },
);

const callOwnerOutput = Type.Object(
  {
    callId: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    hint: Type.Optional(Type.String()),
    transcript: Type.Optional(Type.Array(transcriptSchema)),
  },
  { additionalProperties: false },
);

const callStatusParameters = Type.Object(
  {
    call_id: Type.Optional(
      Type.String({
        description: "The call id returned by whatsapp_call_owner. Omit it to list the most recent calls.",
      }),
    ),
  },
  { additionalProperties: false },
);

const callStatusOutput = Type.Object(
  {
    call: Type.Optional(callRecordSchema),
    calls: Type.Optional(Type.Array(callRecordSchema)),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const toolPlugin = defineToolPlugin({
  id: PLUGIN_ID,
  name: "WhatsApp Voice (StepFun)",
  description:
    "Place WhatsApp voice calls to the owner with StepFun StepAudio 3 Realtime, and read call transcripts.",
  activation: { onStartup: true, onCommands: ["whatsapp-voice"] },
  configSchema,
  tools: (tool) => [
    tool({
      name: "whatsapp_call_owner",
      label: "WhatsApp call",
      description:
        "Call the owner on WhatsApp and talk to them out loud with a realtime voice agent. Use it when a call is genuinely the right channel, and when the owner may not read messages. The voice can consult the OpenClaw agent for real work during the call.",
      parameters: callOwnerParameters,
      outputSchema: callOwnerOutput,
      async execute(params, _config, context) {
        const current = services();
        if (!current) {
          return { error: "The WhatsApp voice plugin is not initialized yet." };
        }
        const result = await callOwner(params, current, context.signal);
        if (result.status === "completed" && result.transcript?.length) {
          const transcript = result.transcript
            .map((turn) => `${turn.role ?? "speaker"}: ${turn.text ?? ""}`)
            .join("\n");
          return { ...result, note: `The call finished. Transcript:\n${transcript}` };
        }
        return { ...result };
      },
    }),
    tool({
      name: "whatsapp_call_status",
      label: "WhatsApp call status",
      description:
        "Read the status and transcript of a WhatsApp voice call. Pass a call id, or omit it to list the most recent calls.",
      parameters: callStatusParameters,
      outputSchema: callStatusOutput,
      async execute(params) {
        const current = services();
        if (!current) {
          return { error: "The WhatsApp voice plugin is not initialized yet." };
        }
        return { ...(await callStatus(params, current)) };
      },
    }),
  ],
});

const entry = definePluginEntry({
  id: PLUGIN_ID,
  name: "WhatsApp Voice (StepFun)",
  description:
    "Place WhatsApp voice calls to the owner with StepFun StepAudio 3 Realtime, and read call transcripts.",
  configSchema: () => buildJsonPluginConfigSchema(configSchema as unknown as Record<string, unknown>),
  register(api: OpenClawPluginApi) {
    hostStore.setRuntime({ api, runtime: api.runtime });

    toolPlugin.register(api);

    api.registerToolMetadata({
      toolName: "whatsapp_call_owner",
      displayName: "WhatsApp call",
      description: "Call the owner on WhatsApp with a realtime voice agent.",
      risk: "high",
      tags: ["phone", "voice"],
    });

    api.registerToolMetadata({
      toolName: "whatsapp_call_status",
      displayName: "WhatsApp call status",
      description: "Read the status and transcript of a WhatsApp voice call.",
      risk: "low",
      tags: ["phone", "voice"],
    });

    api.registerCli(
      async ({ program, config }) => {
        const ctx: CliContext = {
          config: () => pluginConfigOf(config, api.pluginConfig),
          runtime: () => hostStore.tryGetRuntime()?.runtime ?? null,
        };
        registerWhatsAppVoiceCli(program, ctx);
      },
      {
        descriptors: [
          {
            name: "whatsapp-voice",
            description: "WhatsApp voice calls: install, pair and run the sidecar",
            hasSubcommands: true,
          },
        ],
      },
    );

    api.lifecycle.registerRuntimeLifecycle({
      id: "whatsapp-voice-consult-bridge",
      description: "Close the loopback bridge the sidecar consults during a call.",
      dispose: async () => {
        await closeBridge();
      },
    });
  },
});

Object.defineProperty(entry, toolPluginMetadataSymbol, {
  value: getToolPluginMetadata(toolPlugin),
  enumerable: false,
});

export default entry;

export { ensureBridge };

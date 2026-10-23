import { Type } from "typebox";

/**
 * Plugin config. Everything is optional so the plugin still loads (and its CLI still works)
 * before the owner has paired a WhatsApp number. `openclaw plugins build` turns this into the
 * JSON Schema in `openclaw.plugin.json`.
 */
export const configSchema = Type.Object(
  {
    ownerNumber: Type.Optional(
      Type.String({
        description:
          "Your WhatsApp number in international format, e.g. +15551234567. The only number called, and the only caller answered.",
      }),
    ),
    voiceModel: Type.Optional(
      Type.String({ description: "StepFun Realtime model ID.", default: "stepaudio-3-realtime-preview" }),
    ),
    voice: Type.Optional(
      Type.String({
        description: "StepFun voice ID, e.g. jingdiannvsheng, wenrounansheng, qingchunshaonv.",
        default: "jingdiannvsheng",
      }),
    ),
    assistantName: Type.Optional(
      Type.String({ description: "Fallback name, used only when the agent gives no persona briefing.", default: "OpenClaw" }),
    ),
    languages: Type.Optional(
      Type.String({
        description: "Comma-separated language codes the voice may speak and listen for, e.g. en-US, ta-IN. Empty: any language.",
      }),
    ),
    voiceInstructions: Type.Optional(
      Type.String({ description: "Your own rules for the voice: language, tone, call length." }),
    ),
    ringTimeoutSeconds: Type.Optional(
      Type.Number({ description: "How long an outgoing call rings before it counts as unanswered.", default: 45 }),
    ),
    maxCallMinutes: Type.Optional(
      Type.Number({ description: "Calls end automatically after this. StepFun sessions are capped at 30 minutes.", default: 15 }),
    ),
    silenceHangupSeconds: Type.Optional(
      Type.Number({ description: "Ends a call when nobody has spoken for this long, e.g. left on hold.", default: 180 }),
    ),
    answerInbound: Type.Optional(
      Type.Boolean({ description: "Pick up when your number calls the bot. Other callers are never answered.", default: true }),
    ),
    sendSummary: Type.Optional(
      Type.Boolean({ description: "Message a short WhatsApp summary after each call.", default: true }),
    ),
    realtimeConfig: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Any StepFun Realtime session field, merged over the defaults. Reference: https://platform.stepfun.com/docs/zh/api-reference/realtime/chat",
      }),
    ),
    listen: Type.Optional(
      Type.String({ description: "Loopback address of the sidecar's local API.", default: "127.0.0.1:8796" }),
    ),
    consultListen: Type.Optional(
      Type.String({ description: "Loopback address the plugin's agent bridge listens on.", default: "127.0.0.1:8797" }),
    ),
    stepfunApiKey: Type.Optional(
      Type.String({
        description: "StepFun API key for StepAudio 3 Realtime. Falls back to the STEPFUN_API_KEY environment variable.",
      }),
    ),
    agentId: Type.Optional(
      Type.String({ description: "Which OpenClaw agent the voice consults during a call. Default: the default agent." }),
    ),
    autoStart: Type.Optional(
      Type.Boolean({ description: "Start the sidecar on demand when a call is requested.", default: true }),
    ),
  },
  { additionalProperties: false },
);

export type PluginConfig = {
  ownerNumber?: string;
  voiceModel?: string;
  voice?: string;
  assistantName?: string;
  languages?: string;
  voiceInstructions?: string;
  ringTimeoutSeconds?: number;
  maxCallMinutes?: number;
  silenceHangupSeconds?: number;
  answerInbound?: boolean;
  sendSummary?: boolean;
  realtimeConfig?: Record<string, unknown>;
  listen?: string;
  consultListen?: string;
  stepfunApiKey?: string;
  agentId?: string;
  autoStart?: boolean;
};

export interface ResolvedSettings {
  ownerNumber: string;
  voiceModel: string;
  voice: string;
  assistantName: string;
  languages: string;
  voiceInstructions: string;
  ringTimeoutSeconds: number;
  maxCallMinutes: number;
  silenceHangupSeconds: number;
  answerInbound: boolean;
  sendSummary: boolean;
  realtimeConfig: Record<string, unknown>;
  listen: string;
  consultListen: string;
  stepfunApiKey: string;
  agentId: string;
  autoStart: boolean;
}

export const DEFAULTS: ResolvedSettings = {
  ownerNumber: "",
  voiceModel: "stepaudio-3-realtime-preview",
  voice: "jingdiannvsheng",
  assistantName: "OpenClaw",
  languages: "",
  voiceInstructions: "",
  ringTimeoutSeconds: 45,
  maxCallMinutes: 15,
  silenceHangupSeconds: 180,
  answerInbound: true,
  sendSummary: true,
  realtimeConfig: {},
  listen: "127.0.0.1:8796",
  consultListen: "127.0.0.1:8797",
  stepfunApiKey: "",
  agentId: "",
  autoStart: true,
};

export function resolveSettings(config: PluginConfig | undefined): ResolvedSettings {
  const c = config ?? {};
  return {
    ownerNumber: c.ownerNumber?.trim() ?? DEFAULTS.ownerNumber,
    voiceModel: c.voiceModel?.trim() || DEFAULTS.voiceModel,
    voice: c.voice?.trim() || DEFAULTS.voice,
    assistantName: c.assistantName?.trim() || DEFAULTS.assistantName,
    languages: c.languages ?? DEFAULTS.languages,
    voiceInstructions: c.voiceInstructions ?? DEFAULTS.voiceInstructions,
    ringTimeoutSeconds: c.ringTimeoutSeconds ?? DEFAULTS.ringTimeoutSeconds,
    maxCallMinutes: c.maxCallMinutes ?? DEFAULTS.maxCallMinutes,
    silenceHangupSeconds: c.silenceHangupSeconds ?? DEFAULTS.silenceHangupSeconds,
    answerInbound: c.answerInbound ?? DEFAULTS.answerInbound,
    sendSummary: c.sendSummary ?? DEFAULTS.sendSummary,
    realtimeConfig: c.realtimeConfig ?? DEFAULTS.realtimeConfig,
    listen: c.listen?.trim() || DEFAULTS.listen,
    consultListen: c.consultListen?.trim() || DEFAULTS.consultListen,
    stepfunApiKey: c.stepfunApiKey?.trim() || process.env.STEPFUN_API_KEY?.trim() || DEFAULTS.stepfunApiKey,
    agentId: c.agentId?.trim() ?? DEFAULTS.agentId,
    autoStart: c.autoStart ?? DEFAULTS.autoStart,
  };
}

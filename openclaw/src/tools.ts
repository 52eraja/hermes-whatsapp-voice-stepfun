/** The behaviour behind the two agent tools. */

import { SidecarError, type CallRecord } from "./client.js";
import { ensureSidecar, type PluginServices } from "./runtime.js";

/** Statuses that mean the ringing phase is over. */
const SETTLED = new Set(["in_progress", "completed", "no_answer", "rejected", "failed"]);

const FALLBACK_HINT =
  "The owner did not pick up. If this matters, use another channel now, for example an urgent reminder or a message.";

export interface CallOwnerResult {
  callId?: string;
  status?: string;
  note?: string;
  transcript?: CallRecord["transcript"];
  error?: string;
  hint?: string;
}

export interface CallStatusResult {
  call?: CallRecord;
  calls?: CallRecord[];
  error?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

export async function callOwner(
  params: { reason?: string; details?: string },
  services: PluginServices,
  signal?: AbortSignal,
): Promise<CallOwnerResult> {
  const reason = (params.reason ?? "").trim();
  if (!reason) {
    return { error: "reason is required" };
  }
  let client;
  try {
    client = await ensureSidecar(services);
  } catch (err) {
    return {
      error: message(err),
      hint: "Could not place the call. Use another channel to reach the owner.",
    };
  }

  let call: CallRecord;
  try {
    call = await client.startCall(reason, (params.details ?? "").trim());
    const deadline = Date.now() + (services.settings.ringTimeoutSeconds + 20) * 1000;
    while (!SETTLED.has(call.status) && Date.now() < deadline) {
      await sleep(1000, signal);
      call = await client.getCall(call.id);
    }
  } catch (err) {
    if (err instanceof SidecarError) {
      return {
        error: err.message,
        hint: "Could not place the call. Use another channel to reach the owner.",
      };
    }
    throw err;
  }

  const status = call.status;
  if (status === "in_progress") {
    return {
      callId: call.id,
      status,
      note: "The owner answered and is talking with the voice agent now. A summary is sent to WhatsApp when the call ends; use whatsapp_call_status for the transcript.",
    };
  }
  if (status === "completed") {
    return { callId: call.id, status, transcript: call.transcript };
  }
  if (status === "no_answer" || status === "rejected") {
    return { callId: call.id, status, note: FALLBACK_HINT };
  }
  if (status === "failed") {
    return {
      callId: call.id,
      status,
      error: call.end_reason ?? "call failed",
      note: FALLBACK_HINT,
    };
  }
  return {
    callId: call.id,
    status,
    note: "Still ringing past the timeout; check again with whatsapp_call_status.",
  };
}

export async function callStatus(
  params: { call_id?: string },
  services: PluginServices,
): Promise<CallStatusResult> {
  try {
    const client = await ensureSidecar(services);
    const callId = (params.call_id ?? "").trim();
    if (callId) {
      return { call: await client.getCall(callId) };
    }
    return { calls: await client.recentCalls() };
  } catch (err) {
    return { error: message(err) };
  }
}

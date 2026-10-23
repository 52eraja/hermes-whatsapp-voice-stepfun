/** Client for the sidecar's loopback HTTP API. */

export class SidecarError extends Error {}

export type CallStatus =
  | "dialing"
  | "ringing"
  | "in_progress"
  | "completed"
  | "no_answer"
  | "rejected"
  | "failed";

export interface TranscriptTurn {
  role: string;
  text: string;
}

export interface CallRecord {
  id: string;
  direction: "inbound" | "outbound";
  status: CallStatus;
  reason: string;
  started_at: number;
  answered_at?: number | null;
  ended_at?: number | null;
  end_reason?: string | null;
  transcript: TranscriptTurn[];
  summary?: string | null;
}

export interface SidecarHealth {
  ok: boolean;
  version: string;
  logged_in: boolean;
  active_call?: string | null;
  hermes_connected: boolean;
}

export class SidecarClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.base + path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const payload = text ? (JSON.parse(text) as unknown) : {};
      if (!res.ok) {
        const detail =
          typeof payload === "object" && payload !== null && "error" in payload
            ? String((payload as { error: unknown }).error)
            : res.statusText;
        throw new SidecarError(`sidecar returned ${res.status}: ${detail}`);
      }
      return payload;
    } catch (err) {
      if (err instanceof SidecarError) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new SidecarError(
        `sidecar not reachable at ${this.base} (${reason}); is \`openclaw whatsapp-voice serve\` running?`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  health(): Promise<SidecarHealth> {
    return this.request("GET", "/health");
  }

  async startCall(reason: string, details = ""): Promise<CallRecord> {
    return this.request("POST", "/calls", { reason, details });
  }

  async getCall(callId: string): Promise<CallRecord> {
    return this.request("GET", `/calls/${encodeURIComponent(callId)}`);
  }

  async recentCalls(limit = 5): Promise<CallRecord[]> {
    const payload = await this.request("GET", `/calls?limit=${limit}`);
    return (payload?.calls ?? []) as CallRecord[];
  }
}

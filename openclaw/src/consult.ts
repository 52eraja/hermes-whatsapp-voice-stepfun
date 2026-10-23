/**
 * Bridge between the sidecar's voice agent and the OpenClaw agent.
 *
 * The sidecar speaks the `/v1/runs` contract: it POSTs a request, then polls for the answer.
 * This server implements that contract on top of the OpenClaw agent runtime, so the voice on a
 * call can ask the owner's agent for real work (calendar, reminders, files, web).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

/** The slice of `api.runtime` this bridge needs. */
export type ConsultRuntime = PluginRuntime;

export interface EmbeddedAgentResult {
  payloads?: Array<{ text?: string }>;
  meta?: unknown;
  [key: string]: unknown;
}

interface RunState {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  output: string;
  error?: string;
  controller: AbortController;
}

export interface ConsultBridgeOptions {
  runtime: ConsultRuntime | null;
  token: string;
  agentId?: string;
  timeoutMs?: number;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/** The agent that answers during a call: the configured one, else the configured default, else `main`. */
export function resolveConsultAgentId(cfg: unknown, configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    return trimmed;
  }
  const defaults = (cfg as { agents?: { defaults?: { id?: string } } } | undefined)?.agents?.defaults;
  return defaults?.id?.trim() || "main";
}

export function extractText(result: EmbeddedAgentResult | undefined): string {
  if (!result) {
    return "";
  }
  const payloads = result.payloads;
  if (Array.isArray(payloads)) {
    const parts = payloads
      .map((payload) => (typeof payload?.text === "string" ? payload.text : ""))
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  if (typeof result.text === "string") {
    return result.text;
  }
  return "";
}

/** Split a `host:port` pair for `server.listen`. The host stays on loopback. */
export function parseListenAddress(address: string): { host: string; port: number } {
  const trimmed = address.trim();
  const separator = trimmed.lastIndexOf(":");
  if (separator === -1) {
    return { host: "127.0.0.1", port: Number(trimmed) };
  }
  const host = trimmed.slice(0, separator).trim() || "127.0.0.1";
  const port = Number(trimmed.slice(separator + 1).trim());
  return { host, port };
}

export class ConsultBridge {
  private server?: Server;
  private readonly runs = new Map<string, RunState>();

  constructor(private readonly options: ConsultBridgeOptions) {}

  /** Start listening. Returns the base URL the sidecar should call. */
  async listen(address: string): Promise<string> {
    if (this.server) {
      return this.baseUrl();
    }
    const { host, port } = parseListenAddress(address);
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        send(res, 500, { error: "internal error" });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    return this.baseUrl();
  }

  baseUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("consult bridge is not listening");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const run of this.runs.values()) {
      run.controller.abort();
    }
    this.runs.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (!header || !this.options.token) {
      return false;
    }
    return constantTimeEquals(header, `Bearer ${this.options.token}`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      send(res, 401, { error: "bad or missing token" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "POST" && path === "/v1/runs") {
      const body = await readJson(req);
      const input = typeof body?.input === "string" ? body.input : "";
      if (!input.trim()) {
        send(res, 400, { error: "input is required" });
        return;
      }
      const instructions = typeof body?.instructions === "string" ? body.instructions : undefined;
      const sessionId = typeof body?.session_id === "string" ? body.session_id : randomUUID();
      const run: RunState = {
        id: randomUUID(),
        status: "running",
        output: "",
        controller: new AbortController(),
      };
      this.runs.set(run.id, run);
      void this.execute(run, input, instructions, sessionId);
      send(res, 200, { run_id: run.id });
      return;
    }

    const stopMatch = /^\/v1\/runs\/([^/]+)\/stop$/.exec(path);
    if (req.method === "POST" && stopMatch) {
      const run = this.runs.get(decodeURIComponent(stopMatch[1] ?? ""));
      if (!run) {
        send(res, 404, { error: "no such run" });
        return;
      }
      run.controller.abort();
      run.status = "cancelled";
      send(res, 200, { status: run.status });
      return;
    }

    const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(path);
    if (req.method === "GET" && runMatch) {
      const run = this.runs.get(decodeURIComponent(runMatch[1] ?? ""));
      if (!run) {
        send(res, 404, { error: "no such run" });
        return;
      }
      const payload: Record<string, unknown> = { status: run.status };
      if (run.output) {
        payload.output = run.output;
      }
      if (run.error) {
        payload.error = run.error;
      }
      send(res, 200, payload);
      return;
    }

    send(res, 404, { error: "not found" });
  }

  private async execute(
    run: RunState,
    input: string,
    instructions: string | undefined,
    sessionId: string,
  ): Promise<void> {
    const runtime = this.options.runtime;
    if (!runtime) {
      run.status = "failed";
      run.error = "the OpenClaw agent runtime is not available in this process";
      return;
    }
    try {
      const cfg = runtime.config.current() as OpenClawConfig;
      const agentId = resolveConsultAgentId(cfg, this.options.agentId);
      const result = (await runtime.agent.runEmbeddedAgent({
        sessionId,
        runId: run.id,
        workspaceDir: runtime.agent.resolveAgentWorkspaceDir(cfg, agentId),
        prompt: input,
        extraSystemPrompt: instructions,
        agentId,
        timeoutMs: this.options.timeoutMs ?? runtime.agent.resolveAgentTimeoutMs({ cfg }),
        terminalReplyExpectation: "required",
        abortSignal: run.controller.signal,
      })) as unknown as EmbeddedAgentResult;
      if (run.status === "cancelled") {
        return;
      }
      run.output = extractText(result);
      run.status = "completed";
    } catch (err) {
      if (run.status === "cancelled") {
        return;
      }
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
    }
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidecarClient, SidecarError } from "./client.js";

let server: Server;
let base: string;
let seenAuth: string | undefined;
let seenPath: string | undefined;
let seenBody: string | undefined;

beforeEach(async () => {
  server = createServer((req, res) => {
    seenAuth = req.headers.authorization;
    seenPath = req.url;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      seenBody = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no address");
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("SidecarClient", () => {
  it("sends the bearer token", async () => {
    const client = new SidecarClient(base, "secret-token");
    await client.health();
    expect(seenAuth).toBe("Bearer secret-token");
    expect(seenPath).toBe("/health");
  });

  it("posts a call with its reason and details", async () => {
    const client = new SidecarClient(base, "token");
    await client.startCall("Dinner", "table for two");
    expect(seenPath).toBe("/calls");
    expect(seenBody).toBe(JSON.stringify({ reason: "Dinner", details: "table for two" }));
  });

  it("encodes the call id", async () => {
    const client = new SidecarClient(base, "token");
    await client.getCall("call/1");
    expect(seenPath).toBe("/calls/call%2F1");
  });

  it("reads recent calls", async () => {
    const client = new SidecarClient(base, "token");
    await client.recentCalls(3);
    expect(seenPath).toBe("/calls?limit=3");
  });

  it("reports the sidecar's own error text", async () => {
    const failing = createServer((_req, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "a call is already running" }));
    });
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const address = failing.address();
    if (!address || typeof address === "string") {
      throw new Error("no address");
    }
    try {
      const client = new SidecarClient(`http://127.0.0.1:${address.port}`, "token");
      await expect(client.startCall("Dinner")).rejects.toThrow(/a call is already running/);
    } finally {
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });

  it("turns an unreachable sidecar into a readable error", async () => {
    const client = new SidecarClient("http://127.0.0.1:1", "token");
    await expect(client.health()).rejects.toThrow(SidecarError);
    await expect(client.health()).rejects.toThrow(/not reachable/);
  });
});

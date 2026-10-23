import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, resolveSettings } from "./config.js";
import { callOwner, callStatus } from "./tools.js";
import type { PluginServices } from "./runtime.js";

const services = (overrides: Partial<PluginServices["settings"]> = {}): PluginServices => ({
  settings: { ...resolveSettings({}), ...overrides },
  runtime: null,
});

beforeEach(() => {
  vi.stubEnv("STEPFUN_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("callOwner", () => {
  it("needs a reason", async () => {
    const result = await callOwner({ reason: "   " }, services());
    expect(result.error).toBe("reason is required");
  });

  it("explains how to reach the owner when the sidecar cannot start", async () => {
    const result = await callOwner({ reason: "Dinner" }, services({ ownerNumber: "" }));
    expect(result.error).toMatch(/owner number/i);
    expect(result.hint).toMatch(/another channel/i);
  });

  it("complains about a missing StepFun key", async () => {
    const result = await callOwner({ reason: "Dinner" }, services({ ownerNumber: "+15551234567" }));
    expect(result.error).toMatch(/StepFun/i);
  });
});

describe("callStatus", () => {
  it("reports why the sidecar is unreachable", async () => {
    const result = await callStatus({}, services({ ownerNumber: "" }));
    expect(result.error).toMatch(/owner number/i);
  });
});

describe("the default settings", () => {
  it("leaves the owner number unset until it is configured", () => {
    expect(DEFAULTS.ownerNumber).toBe("");
  });
});

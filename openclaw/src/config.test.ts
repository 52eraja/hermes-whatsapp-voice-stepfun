import { describe, expect, it } from "vitest";
import { DEFAULTS, resolveSettings } from "./config.js";

describe("resolveSettings", () => {
  it("falls back to the documented defaults", () => {
    const settings = resolveSettings({});
    expect(settings.voiceModel).toBe(DEFAULTS.voiceModel);
    expect(settings.voice).toBe(DEFAULTS.voice);
    expect(settings.ringTimeoutSeconds).toBe(DEFAULTS.ringTimeoutSeconds);
    expect(settings.answerInbound).toBe(true);
    expect(settings.autoStart).toBe(true);
  });

  it("keeps the owner's number verbatim apart from surrounding space", () => {
    expect(resolveSettings({ ownerNumber: "  +15551234567 " }).ownerNumber).toBe("+15551234567");
  });

  it("prefers the configured StepFun key over the environment", () => {
    const previous = process.env.STEPFUN_API_KEY;
    process.env.STEPFUN_API_KEY = "from-env";
    try {
      expect(resolveSettings({ stepfunApiKey: "from-config" }).stepfunApiKey).toBe("from-config");
      expect(resolveSettings({}).stepfunApiKey).toBe("from-env");
      expect(resolveSettings({ stepfunApiKey: "   " }).stepfunApiKey).toBe("from-env");
    } finally {
      if (previous === undefined) {
        delete process.env.STEPFUN_API_KEY;
      } else {
        process.env.STEPFUN_API_KEY = previous;
      }
    }
  });

  it("ignores blank values that would otherwise fall through to a default", () => {
    expect(resolveSettings({ voiceModel: "  " }).voiceModel).toBe(DEFAULTS.voiceModel);
    expect(resolveSettings({ listen: "" }).listen).toBe(DEFAULTS.listen);
  });
});

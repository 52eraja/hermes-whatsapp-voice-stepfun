import { describe, expect, it } from "vitest";
import { extractText, resolveConsultAgentId } from "./consult.js";

describe("extractText", () => {
  it("joins the payload texts", () => {
    expect(extractText({ payloads: [{ text: "one" }, { text: "two" }] })).toBe("one\ntwo");
  });

  it("ignores payloads without text", () => {
    expect(extractText({ payloads: [{}, { text: "only" }] })).toBe("only");
  });

  it("falls back to a plain text field", () => {
    expect(extractText({ text: "plain" })).toBe("plain");
  });

  it("returns an empty string for nothing usable", () => {
    expect(extractText(undefined)).toBe("");
    expect(extractText({})).toBe("");
    expect(extractText({ payloads: [] })).toBe("");
  });
});

describe("resolveConsultAgentId", () => {
  it("prefers the configured agent", () => {
    expect(resolveConsultAgentId({}, "second")).toBe("second");
  });

  it("uses the configured default agent when there is one", () => {
    expect(resolveConsultAgentId({ agents: { defaults: { id: "work" } } })).toBe("work");
  });

  it("falls back to main", () => {
    expect(resolveConsultAgentId({})).toBe("main");
    expect(resolveConsultAgentId(undefined, "  ")).toBe("main");
  });
});

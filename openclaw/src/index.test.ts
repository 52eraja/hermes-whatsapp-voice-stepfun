import { describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import entry from "./index.js";

interface Registrations {
  tools: string[];
  toolMetadata: string[];
  cliCommands: string[];
  lifecycles: string[];
}

function register(): Registrations {
  const seen: Registrations = { tools: [], toolMetadata: [], cliCommands: [], lifecycles: [] };
  const api = {
    pluginConfig: {},
    runtime: { config: { current: () => ({}) } },
    registerTool: (tool: { name: string }) => {
      seen.tools.push(tool.name);
    },
    registerToolMetadata: (metadata: { toolName: string }) => {
      seen.toolMetadata.push(metadata.toolName);
    },
    registerCli: (_registrar: unknown, opts?: { descriptors?: { name: string }[] }) => {
      for (const descriptor of opts?.descriptors ?? []) {
        seen.cliCommands.push(descriptor.name);
      }
    },
    lifecycle: {
      registerRuntimeLifecycle: (lifecycle: { id: string }) => {
        seen.lifecycles.push(lifecycle.id);
      },
    },
  } as unknown as OpenClawPluginApi;

  entry.register(api);
  return seen;
}

describe("the plugin entry", () => {
  it("registers both agent tools", () => {
    expect(register().tools).toEqual(["whatsapp_call_owner", "whatsapp_call_status"]);
  });

  it("registers metadata for both tools", () => {
    expect(register().toolMetadata).toEqual(["whatsapp_call_owner", "whatsapp_call_status"]);
  });

  it("registers the whatsapp-voice command", () => {
    expect(register().cliCommands).toEqual(["whatsapp-voice"]);
  });

  it("closes the consult bridge when the runtime shuts down", () => {
    expect(register().lifecycles).toEqual(["whatsapp-voice-consult-bridge"]);
  });

  it("carries the authoring metadata the plugin build reads", () => {
    const metadata = getToolPluginMetadata(entry);
    expect(metadata?.id).toBe("whatsapp-voice-stepfun");
    expect(metadata?.tools.map((tool) => tool.name)).toEqual([
      "whatsapp_call_owner",
      "whatsapp_call_status",
    ]);
    expect(metadata?.activation.onCommands).toEqual(["whatsapp-voice"]);
  });
});

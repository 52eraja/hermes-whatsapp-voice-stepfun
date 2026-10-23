import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sidecarRelease } from "./release.js";

const canonical = fileURLToPath(new URL("../../sidecar/release-checksums.txt", import.meta.url));

describe("the pinned sidecar release", () => {
  it("matches the canonical checksum file in the repository", () => {
    const release = sidecarRelease();
    const canonicalChecksums = new Map<string, string>();
    for (const line of readFileSync(canonical, "utf8").split("\n")) {
      const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
      if (match) {
        canonicalChecksums.set(match[2]!, match[1]!);
      }
    }
    expect(canonicalChecksums.size).toBeGreaterThan(0);
    expect(release.checksums).toEqual(Object.fromEntries(canonicalChecksums));
  });

  it("points at the repository that publishes the sidecar", () => {
    expect(sidecarRelease().repo).toBe("52eraja/hermes-whatsapp-voice-stepfun");
  });
});

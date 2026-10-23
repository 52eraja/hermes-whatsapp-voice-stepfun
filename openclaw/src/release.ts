import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface SidecarRelease {
  /** GitHub repository that publishes the sidecar binaries. */
  repo: string;
  /** Release tag the pinned checksums belong to. */
  tag: string;
  /** Asset name to sha256. */
  checksums: Record<string, string>;
}

const releaseFile = fileURLToPath(new URL("../sidecar-release.json", import.meta.url));

export function sidecarRelease(): SidecarRelease {
  const release = JSON.parse(readFileSync(releaseFile, "utf8")) as SidecarRelease;
  if (!release.repo || !release.tag || !release.checksums) {
    throw new Error(`sidecar-release.json is incomplete: ${releaseFile}`);
  }
  return release;
}

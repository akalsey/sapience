import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { isSapienceActive } from "./presence.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "presence-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function writeMarker(ageMs: number): Promise<void> {
  await mkdir(join(dir, "sapience"), { recursive: true });
  const path = join(dir, "sapience", ".present");
  await writeFile(path, "", "utf-8");
  const t = new Date(Date.now() - ageMs);
  await utimes(path, t, t);
}

describe("isSapienceActive", () => {
  it("is false when no marker exists", async () => {
    expect(await isSapienceActive(dir)).toBe(false);
  });

  it("is true for a fresh marker", async () => {
    await writeMarker(0);
    expect(await isSapienceActive(dir)).toBe(true);
  });

  // The marker used to be written once at register() and never expired: after
  // uninstalling sapience, the stale marker kept suppressing thinking's own
  // delivery while nobody routed proposals — orphaned forever.
  it("is false for a marker older than the freshness window", async () => {
    await writeMarker(3 * 60 * 60 * 1000);
    expect(await isSapienceActive(dir)).toBe(false);
  });
});

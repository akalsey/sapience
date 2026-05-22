// src/processed-passes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadProcessedPasses, markPassProcessed } from "./processed-passes.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "sapience-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("loadProcessedPasses", () => {
  it("returns empty set when file does not exist", async () => {
    const set = await loadProcessedPasses(join(dir, "processed.json"));
    expect(set.size).toBe(0);
  });
});

describe("markPassProcessed", () => {
  it("adds pass_id to set and persists to file", async () => {
    const path = join(dir, "processed.json");
    const set = new Set<string>();
    const updated = await markPassProcessed("pass-1", path, set);
    expect(updated.has("pass-1")).toBe(true);
    const reloaded = await loadProcessedPasses(path);
    expect(reloaded.has("pass-1")).toBe(true);
  });

  it("preserves existing entries", async () => {
    const path = join(dir, "processed.json");
    const set = new Set(["pass-0"]);
    const updated = await markPassProcessed("pass-1", path, set);
    expect(updated.has("pass-0")).toBe(true);
    expect(updated.has("pass-1")).toBe(true);
  });
});

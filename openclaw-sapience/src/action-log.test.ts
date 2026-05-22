// src/action-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { appendAction } from "./action-log.js";
import type { RoutedItem } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "sapience-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const item: RoutedItem = {
  id: "act-1", type: "action", text: "Fix query typo",
  domain: "posthog", action_class: "posthog/action",
  priority: 4, pass_id: "pass-1", pass_timestamp: "2026-05-20T10:00:00Z",
  tier: "act", confidence: 0.85,
};

describe("appendAction", () => {
  it("creates log file and appends entry", async () => {
    const path = join(dir, "action-log.md");
    await appendAction(item, "Query typo fixed", path);
    const content = await readFile(path, "utf-8");
    expect(content).toContain("Fix query typo");
    expect(content).toContain("posthog / posthog/action");
    expect(content).toContain("Query typo fixed");
  });

  it("creates parent directories", async () => {
    const path = join(dir, "sub", "action-log.md");
    await expect(appendAction(item, "note", path)).resolves.not.toThrow();
  });
});

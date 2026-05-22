import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { computeStats, loadSearchLog, appendSearchLog } from "./stats.js";
import type { MemoryEntry } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "stats-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function makeEntry(id: string, tags: string[], body: string, daysAgo = 5): MemoryEntry {
  const d = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return {
    id, tags, body, source: "session", score: 0.5, size_tier: "full",
    created: d, updated: d, last_accessed: d, access_count: 1,
    title: id, filename: `${id}.md`,
  };
}

describe("computeStats", () => {
  it("returns zero stats for empty corpus", () => {
    const stats = computeStats([]);
    expect(stats.total_entries).toBe(0);
    expect(stats.top_tags).toHaveLength(0);
  });

  it("counts total entries", () => {
    const entries = [
      makeEntry("e1", ["posthog", "billing"], "body one"),
      makeEntry("e2", ["github"], "body two"),
    ];
    const stats = computeStats(entries);
    expect(stats.total_entries).toBe(2);
  });

  it("returns top_tags sorted by frequency descending", () => {
    const entries = [
      makeEntry("e1", ["posthog", "billing"], "x"),
      makeEntry("e2", ["posthog"], "x"),
      makeEntry("e3", ["github"], "x"),
    ];
    const stats = computeStats(entries);
    expect(stats.top_tags[0]!.tag).toBe("posthog");
    expect(stats.top_tags[0]!.count).toBe(2);
  });

  it("counts entries created in last 7 days", () => {
    const entries = [
      makeEntry("recent", ["a"], "x", 3),
      makeEntry("old", ["b"], "x", 10),
    ];
    const stats = computeStats(entries);
    expect(stats.created_last_7_days).toBe(1);
  });
});

describe("loadSearchLog / appendSearchLog", () => {
  it("returns empty array when file does not exist", async () => {
    const log = await loadSearchLog(join(dir, "searches.json"));
    expect(log).toHaveLength(0);
  });

  it("appends entry and persists", async () => {
    const path = join(dir, "searches.json");
    await appendSearchLog({ query: "posthog billing", tags: [], result_count: 3, timestamp: new Date().toISOString() }, path);
    const log = await loadSearchLog(path);
    expect(log).toHaveLength(1);
    expect(log[0]!.query).toBe("posthog billing");
  });

  it("trims to maxEntries", async () => {
    const path = join(dir, "searches.json");
    for (let i = 0; i < 10; i++) {
      await appendSearchLog({ query: `query-${i}`, result_count: i, timestamp: new Date().toISOString() }, path, 5);
    }
    const log = await loadSearchLog(path);
    expect(log).toHaveLength(5);
    expect(log[0]!.query).toBe("query-5");
  });
});

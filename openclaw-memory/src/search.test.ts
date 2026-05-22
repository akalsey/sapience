import { describe, it, expect } from "vitest";
import { searchEntries } from "./search.js";
import { buildCorpus } from "./bm25.js";
import type { MemoryEntry } from "./types.js";

function makeEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    created: "2026-05-20T14:00:00Z",
    updated: "2026-05-20T14:00:00Z",
    tags: ["general"],
    source: "session",
    score: 0.5,
    size_tier: "full",
    last_accessed: "2026-05-20T14:00:00Z",
    access_count: 0,
    title: overrides.id,
    body: `Content for ${overrides.id}`,
    filename: `${overrides.id}.md`,
    ...overrides,
  };
}

const entries: MemoryEntry[] = [
  makeEntry({ id: "e1", tags: ["posthog", "billing"], body: "# PostHog billing spike\n\ngroupIdentify caused billing spike" }),
  makeEntry({ id: "e2", tags: ["github"], body: "# GitHub PR workflow\n\nMerge policy for the main branch" }),
  makeEntry({ id: "e3", tags: ["posthog"], body: "# PostHog funnels\n\nFunnel analysis and conversion tracking" }),
];

function makeCorpus(ents: MemoryEntry[]) {
  return buildCorpus(ents.map(e => ({ id: e.id, text: `${e.title} ${e.tags.join(" ")} ${e.body}` })));
}

describe("searchEntries", () => {
  it("returns entries matching query, sorted by score", () => {
    const corpus = makeCorpus(entries);
    const output = searchEntries(entries, corpus, { query: "posthog" }, 30, 1.2, 5, 20);
    expect(output.results.length).toBeGreaterThan(0);
    expect(output.results.every(r => ["e1", "e3"].includes(r.id))).toBe(true);
  });

  it("applies tag filter as hard AND constraint", () => {
    const corpus = makeCorpus(entries);
    const output = searchEntries(entries, corpus, { query: "posthog", tags: ["billing"] }, 30, 1.2, 5, 20);
    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.id).toBe("e1");
  });

  it("respects limit and reports total_matched", () => {
    const corpus = makeCorpus(entries);
    const output = searchEntries(entries, corpus, { query: "posthog", limit: 1 }, 30, 1.2, 5, 20);
    expect(output.results).toHaveLength(1);
    expect(output.total_matched).toBe(2);
  });

  it("returns empty results for no matches", () => {
    const corpus = makeCorpus(entries);
    const output = searchEntries(entries, corpus, { query: "kubernetes deployments" }, 30, 1.2, 5, 20);
    expect(output.results).toHaveLength(0);
    expect(output.total_matched).toBe(0);
  });

  it("excerpt contains query terms", () => {
    const corpus = makeCorpus(entries);
    const output = searchEntries(entries, corpus, { query: "billing spike" }, 30, 1.2, 5, 20);
    expect(output.results[0]!.excerpt.toLowerCase()).toContain("billing");
  });

  it("caps limit at maxLimit", () => {
    const manyEntries = Array.from({ length: 25 }, (_, i) =>
      makeEntry({ id: `e${i}`, tags: ["test"], body: "test query content matching terms" })
    );
    const corpus = makeCorpus(manyEntries);
    const output = searchEntries(manyEntries, corpus, { query: "test", limit: 50 }, 30, 1.2, 5, 20);
    expect(output.results.length).toBeLessThanOrEqual(20);
  });
});

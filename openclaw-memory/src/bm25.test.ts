import { describe, it, expect } from "vitest";
import { tokenize, buildCorpus, scoreDoc, search } from "./bm25.js";

describe("tokenize", () => {
  it("lowercases and splits on whitespace", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });
  it("removes punctuation", () => {
    expect(tokenize("billing, investigation!")).toEqual(["billing", "investigation"]);
  });
  it("filters single-char tokens", () => {
    expect(tokenize("a b cat")).toEqual(["cat"]);
  });
  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
});

const DOCS = [
  { id: "doc-1", text: "posthog billing investigation group identify events" },
  { id: "doc-2", text: "github pull request merge conflict resolution" },
  { id: "doc-3", text: "posthog funnel analysis conversion rate" },
];

describe("buildCorpus", () => {
  it("sets N to document count", () => {
    const corpus = buildCorpus(DOCS);
    expect(corpus.N).toBe(3);
  });
  it("records df for terms appearing in multiple docs", () => {
    const corpus = buildCorpus(DOCS);
    expect(corpus.df.get("posthog")).toBe(2);
    expect(corpus.df.get("github")).toBe(1);
  });
  it("handles empty corpus", () => {
    const corpus = buildCorpus([]);
    expect(corpus.N).toBe(0);
    expect(corpus.avgdl).toBe(0);
  });
});

describe("scoreDoc", () => {
  it("returns 0 for a term not in the document", () => {
    const corpus = buildCorpus(DOCS);
    expect(scoreDoc(corpus, "doc-2", ["posthog"])).toBe(0);
  });
  it("returns higher score for more term matches", () => {
    const corpus = buildCorpus(DOCS);
    const scoreOne = scoreDoc(corpus, "doc-1", ["posthog"]);
    const scoreTwo = scoreDoc(corpus, "doc-1", ["posthog", "billing"]);
    expect(scoreTwo).toBeGreaterThan(scoreOne);
  });
  it("returns 0 for unknown docId", () => {
    const corpus = buildCorpus(DOCS);
    expect(scoreDoc(corpus, "unknown", ["posthog"])).toBe(0);
  });
});

describe("search", () => {
  it("returns docs sorted by score descending", () => {
    const corpus = buildCorpus(DOCS);
    const results = search(corpus, "posthog");
    expect(results[0]!.id).toMatch(/doc-[13]/);
    expect(results.every(r => r.score > 0)).toBe(true);
  });
  it("excludes docs with no matching terms", () => {
    const corpus = buildCorpus(DOCS);
    const results = search(corpus, "posthog");
    expect(results.some(r => r.id === "doc-2")).toBe(false);
  });
  it("returns empty array for empty query", () => {
    const corpus = buildCorpus(DOCS);
    expect(search(corpus, "")).toHaveLength(0);
  });
});

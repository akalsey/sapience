import { tokenize, search as bm25Search } from "./bm25.js";
import type { BM25Corpus } from "./bm25.js";
import type { MemoryEntry, MemorySearchInput, MemorySearchOutput, MemorySearchResult } from "./types.js";

function extractExcerpt(body: string, queryTokens: string[], maxLength = 200): string {
  if (body.length <= maxLength) return body;
  const lower = body.toLowerCase();
  let bestPos = 0;
  for (const token of queryTokens) {
    const pos = lower.indexOf(token);
    if (pos >= 0) { bestPos = pos; break; }
  }
  const start = Math.max(0, bestPos - 60);
  const end = Math.min(body.length, start + maxLength);
  const excerpt = body.slice(start, end).trim();
  return (start > 0 ? "…" : "") + excerpt + (end < body.length ? "…" : "");
}

function recencyBoost(createdAt: string, boostDays: number, maxBoost: number): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  if (ageDays >= boostDays) return 1.0;
  return 1.0 + (maxBoost - 1.0) * (1 - ageDays / boostDays);
}

function accessBoost(accessCount: number): number {
  return 1.0 + Math.min(0.1, accessCount * 0.01);
}

export function searchEntries(
  entries: MemoryEntry[],
  corpus: BM25Corpus,
  input: MemorySearchInput,
  recencyBoostDays: number,
  recencyBoostMax: number,
  defaultLimit: number,
  maxLimit: number,
): MemorySearchOutput {
  const limit = Math.min(input.limit ?? defaultLimit, maxLimit);
  const tagFilter = input.tags?.map(t => t.toLowerCase()) ?? [];

  let candidates = entries;
  if (tagFilter.length > 0) {
    candidates = entries.filter(e =>
      tagFilter.every(tag => e.tags.map(t => t.toLowerCase()).includes(tag))
    );
  }

  const candidateIds = new Set(candidates.map(e => e.id));
  const entryMap = new Map(entries.map(e => [e.id, e]));
  const bm25Results = bm25Search(corpus, input.query).filter(r => candidateIds.has(r.id));

  const queryTokens = tokenize(input.query);
  const boosted = bm25Results
    .map(r => {
      const entry = entryMap.get(r.id)!;
      const score = r.score
        * recencyBoost(entry.created, recencyBoostDays, recencyBoostMax)
        * accessBoost(entry.access_count);
      return { entry, score };
    })
    .sort((a, b) => b.score - a.score);

  const totalMatched = boosted.length;
  const results: MemorySearchResult[] = boosted.slice(0, limit).map(({ entry, score }) => ({
    id: entry.id,
    title: entry.title,
    excerpt: extractExcerpt(entry.body, queryTokens),
    tags: entry.tags,
    created: entry.created,
    score,
    size_tier: entry.size_tier,
  }));

  return { results, total_matched: totalMatched };
}

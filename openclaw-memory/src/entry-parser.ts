import matter from "gray-matter";
import type { MemoryEntry, MemoryEntryFrontmatter, MemorySource, SizeTier } from "./types.js";
import { extractTitle } from "./utils.js";

export function parseEntry(raw: string, filename: string): MemoryEntry {
  const parsed = matter(raw);
  const fm = parsed.data as Partial<MemoryEntryFrontmatter>;
  const body = parsed.content.trim();
  const slug = filename.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");

  return {
    id: fm.id ?? "",
    created: fm.created ?? new Date().toISOString(),
    updated: fm.updated ?? new Date().toISOString(),
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    source: (fm.source ?? "manual") as MemorySource,
    score: fm.score ?? 0.5,
    size_tier: (fm.size_tier ?? "full") as SizeTier,
    last_accessed: fm.last_accessed ?? new Date().toISOString(),
    access_count: fm.access_count ?? 0,
    title: extractTitle(body, slug),
    body,
    filename,
  };
}

export function serializeEntry(entry: MemoryEntry): string {
  const { title: _title, body, filename: _filename, ...fm } = entry;
  return matter.stringify("\n" + body, fm);
}

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { MemoryEntry, MemoryStatsOutput, SearchLogEntry } from "./types.js";

export function computeStats(entries: MemoryEntry[]): MemoryStatsOutput {
  const now = Date.now();
  const sevenDays = 7 * 86_400_000;
  const tagCounts = new Map<string, number>();
  let totalSizeBytes = 0;
  let totalTokens = 0;
  let createdRecently = 0;
  let accessedRecently = 0;

  for (const e of entries) {
    totalSizeBytes += e.body.length + 200;
    totalTokens += e.body.split(/\s+/).filter(Boolean).length;
    for (const tag of e.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    if (now - new Date(e.created).getTime() < sevenDays) createdRecently++;
    if (now - new Date(e.last_accessed).getTime() < sevenDays) accessedRecently++;
  }

  const top_tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }));

  return {
    total_entries: entries.length,
    total_size_bytes: totalSizeBytes,
    avg_tokens_per_entry: entries.length > 0 ? Math.round(totalTokens / entries.length) : 0,
    top_tags,
    created_last_7_days: createdRecently,
    accessed_last_7_days: accessedRecently,
  };
}

export async function loadSearchLog(logPath: string): Promise<SearchLogEntry[]> {
  try {
    return JSON.parse(await readFile(logPath, "utf-8")) as SearchLogEntry[];
  } catch { return []; }
}

export async function appendSearchLog(
  entry: SearchLogEntry,
  logPath: string,
  maxEntries = 50,
): Promise<void> {
  const log = await loadSearchLog(logPath);
  const updated = [...log, entry].slice(-maxEntries);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, JSON.stringify(updated, null, 2), "utf-8");
}

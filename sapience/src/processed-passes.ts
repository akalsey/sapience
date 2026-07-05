// src/processed-passes.ts
import { readFile } from "fs/promises";
import { resolvePath } from "./utils.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

export async function loadProcessedPasses(path: string): Promise<Set<string>> {
  const data = await readJsonSafe<{ pass_ids: string[] }>(resolvePath(path), { pass_ids: [] });
  return new Set(Array.isArray(data.pass_ids) ? data.pass_ids : []);
}

export async function bootstrapProcessedPasses(
  proposalsPath: string,
  processedPath: string,
): Promise<Set<string>> {
  try {
    const content = await readFile(resolvePath(proposalsPath), "utf-8");
    const ids = new Set(
      content.trim().split("\n").filter(Boolean)
        .map(l => (JSON.parse(l) as { pass_id: string }).pass_id)
    );
    if (ids.size === 0) return ids;
    await writeJsonAtomic(resolvePath(processedPath), { pass_ids: [...ids] });
    return ids;
  } catch { return new Set(); }
}

const MAX_PROCESSED_ENTRIES = 1000;

export async function markPassProcessed(
  passId: string,
  path: string,
  processed: Set<string>
): Promise<Set<string>> {
  let ids = [...processed, passId];
  if (ids.length > MAX_PROCESSED_ENTRIES) {
    ids = ids.slice(ids.length - MAX_PROCESSED_ENTRIES);
  }
  const updated = new Set(ids);
  await writeJsonAtomic(resolvePath(path), { pass_ids: ids });
  return updated;
}

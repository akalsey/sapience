// src/processed-passes.ts
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { resolvePath } from "./utils.js";

export async function loadProcessedPasses(path: string): Promise<Set<string>> {
  try {
    const data = JSON.parse(await readFile(resolvePath(path), "utf-8")) as { pass_ids: string[] };
    return new Set(data.pass_ids);
  } catch { return new Set(); }
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
    const resolved = resolvePath(processedPath);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, JSON.stringify({ pass_ids: [...ids] }, null, 2), "utf-8");
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
  const resolved = resolvePath(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify({ pass_ids: ids }, null, 2), "utf-8");
  return updated;
}

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

export async function markPassProcessed(
  passId: string,
  path: string,
  processed: Set<string>
): Promise<Set<string>> {
  const updated = new Set([...processed, passId]);
  const resolved = resolvePath(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify({ pass_ids: [...updated] }, null, 2), "utf-8");
  return updated;
}

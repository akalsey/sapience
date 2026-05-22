import { readFile, writeFile, unlink, readdir } from "fs/promises";
import { join } from "path";
import { parseEntry, serializeEntry } from "./entry-parser.js";
import { MEMORY_FILENAME_PATTERN } from "./utils.js";
import type { MemoryEntry } from "./types.js";

export async function readEntry(indexedDir: string, filename: string): Promise<MemoryEntry> {
  const raw = await readFile(join(indexedDir, filename), "utf-8");
  return parseEntry(raw, filename);
}

export async function writeEntry(indexedDir: string, entry: MemoryEntry): Promise<void> {
  await writeFile(join(indexedDir, entry.filename), serializeEntry(entry), "utf-8");
}

export async function deleteEntry(indexedDir: string, filename: string): Promise<void> {
  await unlink(join(indexedDir, filename));
}

export async function listEntryFilenames(indexedDir: string): Promise<string[]> {
  try {
    const files = await readdir(indexedDir);
    return files.filter(f => MEMORY_FILENAME_PATTERN.test(f)).sort();
  } catch { return []; }
}

export async function loadAllEntries(indexedDir: string): Promise<MemoryEntry[]> {
  const filenames = await listEntryFilenames(indexedDir);
  return Promise.all(filenames.map(f => readEntry(indexedDir, f)));
}

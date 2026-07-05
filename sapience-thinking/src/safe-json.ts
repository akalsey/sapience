import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { dirname } from "path";

// Write JSON via temp-file + rename so a crash mid-write can never leave a
// truncated file behind. Bare writeFile truncates in place; combined with
// loaders that treat parse errors as "empty", one crash could permanently
// wipe learned state (the next save persisted the emptiness).
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
  await rename(tmp, path);
}

// Missing file → fallback. Unparseable file → quarantine it to
// `<path>.corrupt-<timestamp>` and return the fallback. Quarantining preserves
// the data for recovery, keeps a durable trace of the corruption, and clears
// the path so a subsequent save can't overwrite the evidence.
export async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try { await rename(path, `${path}.corrupt-${stamp}`); } catch { /* best effort */ }
    return fallback;
  }
}

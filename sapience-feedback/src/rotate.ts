import { readFile, writeFile, rename, stat } from "fs/promises";

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP_LINES = 500;

// Size-bounded rotation for append-only line files (logs, jsonl sidecars).
// When the file exceeds maxBytes, the full contents move to a single `<path>.old`
// archive (replacing the previous one — total disk stays bounded at ~2x
// maxBytes) and the newest keepLines lines stay in place so recent context
// survives. Same benign race as the events rotation: a concurrent append
// between read and rename can lose at most one line.
export async function rotateKeepingTail(
  path: string,
  opts: { maxBytes?: number; keepLines?: number } = {}
): Promise<boolean> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepLines = opts.keepLines ?? DEFAULT_KEEP_LINES;
  let content: string;
  try {
    const s = await stat(path);
    if (s.size <= maxBytes) return false;
    content = await readFile(path, "utf-8");
  } catch {
    return false; // missing file: nothing to rotate
  }

  const lines = content.split("\n").filter(Boolean);
  const tail = lines.slice(-keepLines).join("\n") + "\n";

  await writeFile(`${path}.old`, content, "utf-8");
  await writeFile(`${path}.tmp-rotate`, tail, "utf-8");
  await rename(`${path}.tmp-rotate`, path);
  return true;
}

import { open } from "fs/promises";
import { resolvePath } from "./utils.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

export async function loadPosition(posPath: string): Promise<number> {
  const data = await readJsonSafe<{ position: number }>(resolvePath(posPath), { position: 0 });
  const p = data.position;
  return Number.isInteger(p) && p >= 0 ? p : 0;
}

export async function savePosition(position: number, posPath: string): Promise<void> {
  await writeJsonAtomic(resolvePath(posPath), { position });
}

export async function readNewGoals(
  inboxPath: string,
  posPath: string
): Promise<{ goals: string[]; newPosition: number }> {
  const resolved = resolvePath(inboxPath);
  const position = await loadPosition(posPath);
  let fh;
  try {
    fh = await open(resolved, "r");
    const stat = await fh.stat();
    // Position beyond the file means the inbox shrank (manual edit): treat the
    // file as fully consumed rather than stalling forever or replaying history.
    if (stat.size <= position) return { goals: [], newPosition: Math.min(position, stat.size) };
    const buffer = Buffer.alloc(stat.size - position);
    await fh.read(buffer, 0, buffer.length, position);
    const newText = buffer.toString("utf-8");
    // Only consume up to the last complete line — a writer may be mid-append,
    // and splitting a line (or a multibyte character) would garble the goal.
    const lastNewline = newText.lastIndexOf("\n");
    if (lastNewline === -1) return { goals: [], newPosition: position };
    const complete = newText.slice(0, lastNewline + 1);
    const newPosition = position + Buffer.byteLength(complete, "utf-8");
    const goals = complete
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith("#"));
    return { goals, newPosition };
  } catch {
    // Transient read failure (or missing inbox): keep the position so the next
    // successful read continues where we left off instead of replaying history.
    return { goals: [], newPosition: position };
  }
  finally { await fh?.close(); }
}

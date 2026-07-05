import { open } from "fs/promises";
import { resolvePath } from "./utils.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

export async function loadPosition(posPath: string): Promise<number> {
  const data = await readJsonSafe<{ position: number }>(resolvePath(posPath), { position: 0 });
  return data.position;
}

export async function savePosition(position: number, posPath: string): Promise<void> {
  await writeJsonAtomic(resolvePath(posPath), { position });
}

export async function readNewGoals(
  inboxPath: string,
  posPath: string
): Promise<{ goals: string[]; newPosition: number }> {
  const resolved = resolvePath(inboxPath);
  let fh;
  try {
    fh = await open(resolved, "r");
    const stat = await fh.stat();
    const position = await loadPosition(posPath);
    if (stat.size <= position) return { goals: [], newPosition: position };
    const buffer = Buffer.alloc(stat.size - position);
    await fh.read(buffer, 0, buffer.length, position);
    const newText = buffer.toString("utf-8");
    const newPosition = stat.size;
    const goals = newText
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith("#"));
    return { goals, newPosition };
  } catch { return { goals: [], newPosition: 0 }; }
  finally { await fh?.close(); }
}

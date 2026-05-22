import { readFile, writeFile, open, mkdir } from "fs/promises";
import { dirname } from "path";
import { resolvePath } from "./utils.js";

export async function loadPosition(posPath: string): Promise<number> {
  try {
    const data = JSON.parse(await readFile(resolvePath(posPath), "utf-8")) as { position: number };
    return data.position;
  } catch { return 0; }
}

export async function savePosition(position: number, posPath: string): Promise<void> {
  const resolved = resolvePath(posPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify({ position }, null, 2), "utf-8");
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

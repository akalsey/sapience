import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { ContextBundle, PluginConfig } from "./types.js";
import { estimateTokens, resolvePath } from "./utils.js";

interface SessionEntry {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

function extractText(entry: SessionEntry): string {
  if (!entry.content) return "";
  if (typeof entry.content === "string") return entry.content;
  return entry.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
}

export async function buildContextFromDirs(
  config: PluginConfig,
  sessionDir: string,
  memoryDir: string
): Promise<ContextBundle> {
  const cutoff = Date.now() - config.context.lookbackHours * 60 * 60 * 1000;
  const transcriptBudget = Math.floor(config.context.maxContextTokens * 0.7);
  const memoryBudget = Math.floor(config.context.maxContextTokens * 0.2);

  const chunks: string[] = [];
  let usedTokens = 0;

  try {
    const files = (await readdir(sessionDir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
    for (const file of files) {
      if (usedTokens >= transcriptBudget) break;
      const filePath = join(sessionDir, file);
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs < cutoff) continue;

      const lines = (await readFile(filePath, "utf-8")).trim().split("\n").filter(Boolean);
      const entries: SessionEntry[] = lines
        .map((l) => { try { return JSON.parse(l) as SessionEntry; } catch { return null; } })
        .filter((e): e is SessionEntry => e !== null);

      for (const entry of entries.slice(-50).reverse()) {
        if (!entry.role || !["user", "assistant"].includes(entry.role)) continue;
        const text = extractText(entry).slice(0, 500);
        if (!text) continue;
        const chunk = `[${entry.role}]: ${text}`;
        const tokens = estimateTokens(chunk);
        if (usedTokens + tokens > transcriptBudget) break;
        chunks.push(chunk);
        usedTokens += tokens;
      }
    }
  } catch { /* session dir absent — proceed with empty */ }

  let memoryText = "";
  try {
    const files = (await readdir(memoryDir)).filter((f) => f.endsWith(".md")).slice(0, 20);
    const memChunks: string[] = [];
    let memTokens = 0;
    for (const file of files) {
      const content = (await readFile(join(memoryDir, file), "utf-8")).slice(0, 1000);
      const t = estimateTokens(content);
      if (memTokens + t > memoryBudget) break;
      memChunks.push(content);
      memTokens += t;
    }
    if (memChunks.length > 0) memoryText = `\n\n## Recent Memory\n\n${memChunks.join("\n---\n")}`;
  } catch { /* memory dir absent — skip */ }

  // chunks were pushed newest-first (files desc, entries reversed); restore chronological order
  const activity = chunks.length > 0 ? chunks.reverse().join("\n") : "No recent session activity found.";
  const full = activity + memoryText;

  return { recentActivity: full, recentPasses: "", tokenEstimate: estimateTokens(full) };
}

export async function buildContext(config: PluginConfig, agentId: string): Promise<ContextBundle> {
  const base = join(homedir(), ".openclaw", "agents", agentId);
  return buildContextFromDirs(config, join(base, "sessions"), join(base, "memory"));
}

export async function getLastThreePasses(logPath: string): Promise<string> {
  try {
    const content = await readFile(resolvePath(logPath), "utf-8");
    const sections = content.split(/^## /m).filter(Boolean).slice(-3);
    return sections.length > 0 ? "## " + sections.join("## ") : "";
  } catch {
    return "";
  }
}

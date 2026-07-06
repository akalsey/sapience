import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { ContextBundle, PluginConfig } from "./types.js";
import { estimateTokens, resolvePath } from "./utils.js";

// OpenClaw session transcript line: role/content nested under `message`, with
// content as a string or an array of {type:"text", text} blocks. Legacy
// top-level {role, content} is accepted too. Everything else (session,
// model_change, custom, trajectory records) is ignored.
interface TranscriptLine {
  type?: string;
  role?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown };
}

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join(" ");
  }
  return "";
}

function extractMessage(line: TranscriptLine): { role: string; text: string } | null {
  const src = line.message && typeof line.message === "object" ? line.message : line;
  const role = src.role;
  if (role !== "user" && role !== "assistant") return null;
  const text = extractContent(src.content);
  return text ? { role, text } : null;
}

// A session transcript is `<sessionId>.jsonl`; `<sessionId>.trajectory.jsonl`
// sidecars share the extension but hold trace records, not messages.
function isTranscriptFile(name: string): boolean {
  return name.endsWith(".jsonl") && !name.includes(".trajectory.");
}

// Summarize in-flight goals from the sapience-goals workspace file so thinking
// passes can ask "what would advance these?" instead of only "what happened?".
// Completed/abandoned goals are noise and excluded.
export async function buildGoalsContext(goalsPath: string): Promise<string> {
  interface GoalLite {
    description?: string;
    status?: string;
    active_approach?: string;
    progress_notes?: Array<{ timestamp?: string; summary?: string }>;
    blockers?: Array<{ description?: string; waiting_on?: string }>;
  }
  let goals: GoalLite[];
  try {
    const parsed = JSON.parse(await readFile(goalsPath, "utf-8"));
    goals = Array.isArray(parsed) ? parsed : [];
  } catch {
    return "";
  }
  const inFlight = goals.filter((g) => g.status === "active" || g.status === "decomposing");
  if (inFlight.length === 0) return "";

  return inFlight.map((g) => {
    const lines = [`- ${g.description ?? "(no description)"} [${g.status}]`];
    if (g.active_approach) lines.push(`  approach: ${g.active_approach}`);
    const latest = g.progress_notes?.[g.progress_notes.length - 1];
    if (latest?.summary) lines.push(`  latest progress: ${latest.summary}`);
    for (const b of g.blockers ?? []) {
      lines.push(`  blocked: ${b.description ?? ""}${b.waiting_on ? ` (waiting on ${b.waiting_on})` : ""}`);
    }
    return lines.join("\n");
  }).join("\n");
}

export async function buildContextFromDirs(
  config: PluginConfig,
  sessionDir: string,
  memoryDirs: string[],
  goalsPath?: string
): Promise<ContextBundle> {
  const cutoff = Date.now() - config.context.lookbackHours * 60 * 60 * 1000;
  const transcriptBudget = Math.floor(config.context.maxContextTokens * 0.7);
  const memoryBudget = Math.floor(config.context.maxContextTokens * 0.2);

  const chunks: string[] = [];
  let usedTokens = 0;

  try {
    const names = (await readdir(sessionDir)).filter(isTranscriptFile);
    // Order by recency (mtime), not by filename — session ids are UUIDs.
    const files: Array<{ name: string; mtimeMs: number }> = [];
    for (const name of names) {
      try {
        const s = await stat(join(sessionDir, name));
        if (s.mtimeMs >= cutoff) files.push({ name, mtimeMs: s.mtimeMs });
      } catch { /* raced deletion */ }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of files) {
      if (usedTokens >= transcriptBudget) break;
      const lines = (await readFile(join(sessionDir, file.name), "utf-8")).trim().split("\n").filter(Boolean);
      for (const raw of lines.slice(-50).reverse()) {
        let parsed: TranscriptLine;
        try { parsed = JSON.parse(raw) as TranscriptLine; } catch { continue; }
        const msg = extractMessage(parsed);
        if (!msg) continue;
        const chunk = `[${msg.role}]: ${msg.text.slice(0, 500)}`;
        const tokens = estimateTokens(chunk);
        if (usedTokens + tokens > transcriptBudget) break;
        chunks.push(chunk);
        usedTokens += tokens;
      }
    }
  } catch { /* session dir absent — proceed with empty */ }

  // Memory: wiki vault first (structured claims memory-wiki renders to disk),
  // then the legacy per-agent memory dir. Newest files first — memory recall
  // here is recency-based; there is no plugin-facing semantic search API in
  // the current SDK.
  let memoryText = "";
  const memFiles: Array<{ path: string; mtimeMs: number }> = [];
  for (const dir of memoryDirs) {
    try {
      for (const name of (await readdir(dir)).filter((f) => f.endsWith(".md"))) {
        try {
          const s = await stat(join(dir, name));
          memFiles.push({ path: join(dir, name), mtimeMs: s.mtimeMs });
        } catch { /* raced deletion */ }
      }
    } catch { /* dir absent — skip */ }
  }
  memFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const memChunks: string[] = [];
  let memTokens = 0;
  for (const file of memFiles.slice(0, 40)) {
    let content: string;
    try { content = (await readFile(file.path, "utf-8")).slice(0, 1000); } catch { continue; }
    const t = estimateTokens(content);
    if (memTokens + t > memoryBudget) break;
    memChunks.push(content);
    memTokens += t;
  }
  if (memChunks.length > 0) memoryText = `\n\n## Recent Memory\n\n${memChunks.join("\n---\n")}`;

  const activeGoals = goalsPath ? await buildGoalsContext(goalsPath) : "";

  // chunks were pushed newest-first (files desc, entries reversed); restore chronological order
  const activity = chunks.length > 0 ? chunks.reverse().join("\n") : "No recent session activity found.";
  const full = activity + memoryText;

  return { recentActivity: full, recentPasses: "", activeGoals, tokenEstimate: estimateTokens(full) + estimateTokens(activeGoals) };
}

export interface ContextDirs {
  sessionsDir: string;
  memoryDirs: string[];
}

// Resolve where sessions and memory actually live, via the runtime when
// available. The previous implementation hardcoded ~/.openclaw/agents/<id>/
// {sessions,memory} — the memory dir doesn't exist on real installs (memory
// lives in the memory-core store and the wiki vault), so passes ran blind.
export function resolveContextDirs(api: any, agentId: string): ContextDirs {
  let stateDir: string;
  try {
    stateDir = api?.runtime?.state?.resolveStateDir?.() ?? join(homedir(), ".openclaw");
  } catch {
    stateDir = join(homedir(), ".openclaw");
  }
  let agentDir: string;
  try {
    agentDir = api?.runtime?.agent?.resolveAgentDir?.(api?.config, agentId) ?? join(stateDir, "agents", agentId);
  } catch {
    agentDir = join(stateDir, "agents", agentId);
  }
  const wikiPath: string =
    api?.config?.plugins?.entries?.["memory-wiki"]?.config?.vault?.path ?? join(stateDir, "wiki", "main");

  return {
    sessionsDir: join(agentDir, "sessions"),
    memoryDirs: [wikiPath, join(agentDir, "memory")],
  };
}

export async function buildContext(config: PluginConfig, api: any, agentId: string, workspaceDir: string): Promise<ContextBundle> {
  const dirs = resolveContextDirs(api, agentId);
  // Convention shared with sapience-goals' default output.goalsPath.
  const goalsPath = join(workspaceDir, "goals", "goals.json");
  return buildContextFromDirs(config, dirs.sessionsDir, dirs.memoryDirs, goalsPath);
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

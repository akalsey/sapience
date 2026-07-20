import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { ContextBundle, PluginConfig } from "./types.js";
import { estimateTokens, resolvePath, extractTranscriptMessage } from "./utils.js";

// OpenClaw session transcript line: role/content nested under `message`, with
// content as a string or an array of {type:"text", text} blocks. Legacy
// top-level {role, content} is accepted too. Everything else (session,
// model_change, custom, trajectory records) is ignored.
interface TranscriptLine {
  role?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown };
}

// A session transcript is `<sessionId>.jsonl`; `<sessionId>.trajectory.jsonl`
// sidecars share the extension but hold trace records, not messages.
function isTranscriptFile(name: string): boolean {
  return name.endsWith(".jsonl") && !name.includes(".trajectory.");
}

// Openers of the suite's own machine sessions (cron prompts and sapience
// subagent prompts). Sessions that START with one of these are the suite
// talking to itself — feeding them back into thinking context created a
// feedback loop where passes diagnosed their own 15-minute cadence as a
// critical defect. Matched against the FIRST user message only: a human
// session that merely RECEIVED an injected [SAPIENCE:] prompt stays in.
const MACHINE_SESSION_OPENERS = [
  "You are running a scheduled thinking pass",
  "You are the sapience routing agent",
  "You are the goals tracking agent",
  "You are running a bounded, READ-ONLY investigation",
  "You are executing a pre-approved autonomous action",
  "You are performing a READ-ONLY metric check",
];

// The gateway's periodic poll into its main session. A session that OPENS with
// one is the heartbeat loop, not a conversation; individual polls inside human
// sessions are cadence noise either way.
const HEARTBEAT_POLL_RE = /^\[openclaw heartbeat/i;

function isHeartbeatPoll(text: string): boolean {
  return HEARTBEAT_POLL_RE.test(text.trim());
}

function isMachineSession(lines: string[]): boolean {
  for (const raw of lines.slice(0, 10)) {
    let parsed: TranscriptLine;
    try { parsed = JSON.parse(raw) as TranscriptLine; } catch { continue; }
    const msg = extractTranscriptMessage(parsed);
    if (!msg) continue;
    if (msg.role !== "user") return false; // first message wasn't a machine opener
    if (isHeartbeatPoll(msg.text)) return true;
    return MACHINE_SESSION_OPENERS.some((opener) => msg.text.startsWith(opener));
  }
  return false;
}

// Summarize in-flight goals from the sapience-goals workspace file so thinking
// passes can ask "what would advance these?" instead of only "what happened?".
// Completed/abandoned goals are noise and excluded.
export async function buildGoalsContext(goalsPath: string): Promise<string> {
  interface GoalLite {
    description?: string;
    status?: string;
    active_approach?: string;
    metric?: { name?: string; target?: number; unit?: string };
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
    if (g.metric?.name) lines.push(`  KR: ${g.metric.name} — target ${g.metric.target}${g.metric.unit ?? ""}`);
    const latest = g.progress_notes?.[g.progress_notes.length - 1];
    if (latest?.summary) lines.push(`  latest progress: ${latest.summary}`);
    for (const b of g.blockers ?? []) {
      lines.push(`  blocked: ${b.description ?? ""}${b.waiting_on ? ` (waiting on ${b.waiting_on})` : ""}`);
    }
    return lines.join("\n");
  }).join("\n");
}

// Open cases from the sapience hypothesis ledger, so passes re-test them
// opportunistically when adjacent data is in hand instead of forgetting them.
export async function buildHypothesesContext(path: string): Promise<string> {
  interface HypothesisLite {
    text?: string;
    status?: string;
    sightings?: number;
    evidence?: Array<{ verdict?: string; note?: string }>;
  }
  let list: HypothesisLite[];
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    return "";
  }
  const live = list
    .filter((h) => h.status === "open" || h.status === "supported")
    // Newest-first, capped: a hoarded ledger must not flood the pass context.
    .sort((a, b) => Date.parse((b as { last_seen?: string }).last_seen ?? "") - Date.parse((a as { last_seen?: string }).last_seen ?? ""))
    .slice(0, 10);
  if (live.length === 0) return "";
  return live.map((h) => {
    const latest = h.evidence?.[h.evidence.length - 1];
    const evidenceNote = latest?.note ? ` — latest: ${latest.verdict}, ${latest.note}` : "";
    return `- [${h.status}] ${h.text ?? ""} (seen ${h.sightings ?? 1}x${evidenceNote})`;
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

    // A wedged session repeating one reply verbatim (a production main session
    // answered 646 straight heartbeat polls with the same failure paragraph)
    // must not fill the whole context budget: keep only the first sighting of
    // any exact message text.
    const seenChunks = new Set<string>();
    for (const file of files) {
      if (usedTokens >= transcriptBudget) break;
      const lines = (await readFile(join(sessionDir, file.name), "utf-8")).trim().split("\n").filter(Boolean);
      if (isMachineSession(lines)) continue;
      for (const raw of lines.slice(-50).reverse()) {
        let parsed: TranscriptLine;
        try { parsed = JSON.parse(raw) as TranscriptLine; } catch { continue; }
        const msg = extractTranscriptMessage(parsed);
        if (!msg) continue;
        if (isHeartbeatPoll(msg.text)) continue;
        const chunk = `[${msg.role}]: ${msg.text.slice(0, 500)}`;
        if (seenChunks.has(chunk)) continue;
        seenChunks.add(chunk);
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

// Resolve where sessions and memory actually live via the runtime when
// available, with ~/.openclaw fallbacks. Memory lives in the memory-core store
// and the wiki vault, not in the agent's own directory.
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
  // Conventions shared with sapience-goals' and sapience's default paths.
  const goalsPath = join(workspaceDir, "goals", "goals.json");
  const bundle = await buildContextFromDirs(config, dirs.sessionsDir, dirs.memoryDirs, goalsPath);
  bundle.openHypotheses = await buildHypothesesContext(join(workspaceDir, "sapience", "hypotheses.json"));
  return bundle;
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

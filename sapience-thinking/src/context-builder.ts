import { readdir, readFile, stat } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import type { ContextBundle, PluginConfig } from "./types.js";
import { estimateTokens, resolvePath, extractTranscriptMessage } from "./utils.js";
import { buildInstalledSkillsContext, discoverInstalledSkills, resolveSkillDirs } from "./installed-skills.js";

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
    todos?: Array<{ text?: string; status?: string }>;
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
    // The goal's open checklist — passes should propose work that moves these.
    for (const t of (g.todos ?? []).filter((t) => t.status === "open").slice(0, 5)) {
      lines.push(`  todo: ${t.text ?? ""}`);
    }
    return lines.join("\n");
  }).join("\n");
}

// Restatement clustering for the rendered ledger. Mirrors sapience's own
// near-duplicate rule (jaccard, or containment above a token floor) rather
// than importing it — thinking reads sapience's files but never depends on
// its package. Grouping by the `domain` field would not do: 23 of 25 entries
// in the production ledger were domain "general", including all 8 that
// described the same Google auth failure.
// Keep these in lockstep with the same-named constants in sapience's
// hypotheses.ts — the two copies exist to hold the package boundary, not
// because they are allowed to drift.
const SIMILARITY_THRESHOLD = 0.6;
const CONTAINMENT_THRESHOLD = 0.65;
const CONTAINMENT_MIN_TOKENS = 8;

function hypothesisTokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
      .map((w) => w.replace(/s$/, ""))
  );
}

function restatesSame(a: string, b: string): boolean {
  const ta = hypothesisTokens(a);
  const tb = hypothesisTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  if (intersection / (ta.size + tb.size - intersection) >= SIMILARITY_THRESHOLD) return true;
  const smaller = Math.min(ta.size, tb.size);
  return smaller >= CONTAINMENT_MIN_TOKENS && intersection / smaller >= CONTAINMENT_THRESHOLD;
}

// Open cases from the sapience hypothesis ledger, so passes re-test them
// opportunistically when adjacent data is in hand instead of forgetting them.
export async function buildHypothesesContext(path: string): Promise<string> {
  interface HypothesisLite {
    text?: string;
    status?: string;
    sightings?: number;
    last_seen?: string;
    evidence?: Array<{ verdict?: string; note?: string }>;
  }
  let list: HypothesisLite[];
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    return "";
  }
  const ordered = list
    .filter((h) => h.status === "open" || h.status === "supported")
    // Newest-first: a hoarded ledger must not flood the pass context.
    .sort((a, b) => Date.parse(b.last_seen ?? "") - Date.parse(a.last_seen ?? ""));

  // Collapse restatements BEFORE capping, so one fragmented suspicion cannot
  // occupy the whole budget and read as a stack of independent findings.
  const clusters: Array<{ head: HypothesisLite; restatements: number }> = [];
  for (const h of ordered) {
    const existing = clusters.find((c) => restatesSame(c.head.text ?? "", h.text ?? ""));
    if (existing) existing.restatements++;
    else clusters.push({ head: h, restatements: 0 });
  }

  const live = clusters.slice(0, 10);
  if (live.length === 0) return "";
  return live.map(({ head, restatements }) => {
    const latest = head.evidence?.[head.evidence.length - 1];
    const evidenceNote = latest?.note ? ` — latest: ${latest.verdict}, ${latest.note}` : "";
    const dupes = restatements > 0 ? `, ${restatements} more restatement${restatements > 1 ? "s" : ""} of this same case` : "";
    return `- [${head.status}] ${head.text ?? ""} (seen ${head.sightings ?? 1}x${dupes}${evidenceNote})`;
  }).join("\n");
}

// Open skill proposals from the sapience ledger (absent on standalone
// installs — that's fine, this returns ""). Passes see what has already been
// proposed so they append evidence instead of re-proposing.
export async function buildSkillProposalsContext(path: string): Promise<string> {
  interface ProposalLite {
    id?: string;
    name?: string;
    summary?: string;
    status?: string;
    evidence_count?: number;
    updated_at?: string;
  }
  let list: ProposalLite[];
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    return "";
  }
  const open = list
    .filter((p) => p.status === "proposed" || p.status === "building")
    .sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? ""))
    .slice(0, 10);
  if (open.length === 0) return "";
  return open
    .map((p) => `- [${p.id ?? "?"}] ${p.name ?? ""} — ${p.summary ?? ""} (${p.status}, evidence ×${p.evidence_count ?? 1})`)
    .join("\n");
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
  let sessionsDirMissing = false;

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
  } catch {
    // A missing session directory and a genuinely quiet day used to produce
    // the identical "No recent session activity" string, so a misresolved path
    // was indistinguishable from silence and went unnoticed for weeks while
    // the pass reasoned entirely from its own prior output. Say which it is.
    sessionsDirMissing = true;
  }

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
  const activity = chunks.length > 0
    ? chunks.reverse().join("\n")
    : sessionsDirMissing
      ? `SESSION TRANSCRIPTS UNAVAILABLE — the session directory could not be read (${sessionDir}). This is a configuration fault, not a quiet period: you are blind to all conversation, including anything the user has told or corrected you about. Do not infer from this that nothing happened or that any problem is unresolved.`
      : "No recent session activity found.";
  const full = activity + memoryText;

  return {
    recentActivity: full,
    recentPasses: "",
    activeGoals,
    sessionsDirMissing,
    tokenEstimate: estimateTokens(full) + estimateTokens(activeGoals),
  };
}

export interface ContextDirs {
  sessionsDir: string;
  memoryDirs: string[];
  sessionsDirExists: boolean;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// Every agent directory on disk that actually holds a sessions/ dir, newest
// first. The last-resort answer to "the configured id is wrong" — which it was
// in production for weeks.
async function discoverAgentSessionDirs(stateDir: string): Promise<string[]> {
  const root = join(stateDir, "agents");
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const found: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    const candidate = join(root, name, "sessions");
    try {
      const s = await stat(candidate);
      if (s.isDirectory()) found.push({ path: candidate, mtimeMs: s.mtimeMs });
    } catch { /* not an agent dir */ }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
}

// Resolve where sessions and memory actually live via the runtime when
// available, with ~/.openclaw fallbacks. Memory lives in the memory-core store
// and the wiki vault, not in the agent's own directory.
//
// Sessions are a SIBLING of the agent data dir: `agents/<id>/sessions` holds
// the transcripts while `agents/<id>/agent/` holds sqlite, models and plugin
// state. Joining "sessions" onto the agent dir — which this did — points at a
// path that has never existed on any install.
//
// The id itself is checked against the disk rather than trusted: a real
// OpenClaw config has no `agent.id` key (it uses `agents.defaults`), so a
// plugin reading `config.agent?.id` gets undefined and whatever its fallback
// says. The live agent is `main`. Candidates are tried in order and the first
// one that exists wins, so a wrong id self-corrects instead of silently
// yielding an empty context.
export async function resolveContextDirs(api: any, agentId: string): Promise<ContextDirs> {
  let stateDir: string;
  try {
    stateDir = api?.runtime?.state?.resolveStateDir?.() ?? join(homedir(), ".openclaw");
  } catch {
    stateDir = join(homedir(), ".openclaw");
  }
  let runtimeAgentDir: string | undefined;
  try {
    runtimeAgentDir = api?.runtime?.agent?.resolveAgentDir?.(api?.config, agentId);
  } catch { /* helper absent or threw — fall through to path candidates */ }

  const candidates = [...new Set([
    // resolveAgentDir returns the agent DATA dir (`agents/<id>/agent`) on the
    // production gateway, so sessions are its sibling. An older layout — and
    // this plugin's own test mock — had it return the agent root, which is why
    // the child form stayed wrong for weeks without failing a test. Probe both
    // and let the disk decide which layout this install actually has.
    ...(runtimeAgentDir ? [join(dirname(runtimeAgentDir), "sessions"), join(runtimeAgentDir, "sessions")] : []),
    join(stateDir, "agents", agentId, "sessions"),
    join(stateDir, "agents", "main", "sessions"),
  ])];

  // When nothing resolves, report the CONVENTIONAL path rather than the first
  // guess — it is the one a human should go looking at.
  let sessionsDir = join(stateDir, "agents", agentId, "sessions");
  let sessionsDirExists = false;
  for (const candidate of candidates) {
    if (await isDir(candidate)) {
      sessionsDir = candidate;
      sessionsDirExists = true;
      break;
    }
  }

  // Only when every cheap candidate missed: a readdir of agents/ plus a stat
  // per entry is not worth paying on every pass just to discard the result.
  if (!sessionsDirExists) {
    const [discovered] = await discoverAgentSessionDirs(stateDir);
    if (discovered) {
      sessionsDir = discovered;
      sessionsDirExists = true;
    }
  }

  const wikiPath: string =
    api?.config?.plugins?.entries?.["memory-wiki"]?.config?.vault?.path ?? join(stateDir, "wiki", "main");
  const agentRoot = dirname(sessionsDir);

  return {
    sessionsDir,
    sessionsDirExists,
    memoryDirs: [wikiPath, join(agentRoot, "memory"), join(agentRoot, "agent", "memory")],
  };
}

export async function buildContext(config: PluginConfig, api: any, agentId: string, workspaceDir: string): Promise<ContextBundle> {
  const dirs = await resolveContextDirs(api, agentId);
  // Conventions shared with sapience-goals' and sapience's default paths.
  const goalsPath = join(workspaceDir, "goals", "goals.json");
  const bundle = await buildContextFromDirs(config, dirs.sessionsDir, dirs.memoryDirs, goalsPath);
  bundle.openHypotheses = await buildHypothesesContext(join(workspaceDir, "sapience", "hypotheses.json"));
  bundle.openSkillProposals = await buildSkillProposalsContext(join(workspaceDir, "sapience", "skill-proposals.json"));
  // What already exists. A pass that can't see the installed skills proposes
  // building things the install has had for months.
  bundle.installedSkills = buildInstalledSkillsContext(
    await discoverInstalledSkills(resolveSkillDirs(api, workspaceDir, config.skillsDirs))
  );
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

import { stat, readdir, readFile } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { readStatusArtifacts, resolveStateBase } from "../status-artifact.js";
import { SUITE_PLUGINS, SUITE_CRON_BASES, ALL_SUITE_CRON_BASES, SUITE_TOOL_NAMES, SUITE_FILES, MEMORY_SETTINGS, CORE_GOAL_TOOLS, GOAL_TOOL_PROFILES, DELIVERING_PLUGINS } from "./inventory.js";
import { parseHostVersion, type HostVersionObservation } from "./host-version.js";
import type {
  DoctorInputs,
  PluginObservation,
  CronObservation,
  FileObservation,
  WorkspaceObservation,
  MemoryObservation,
  GoalToolCollisionObservation,
  StatusArtifact,
  VersionObservation,
} from "./types.js";

const exec = promisify(execFile);

// Reads a dotted "plugins.entries.<id>.config.<rest>" path (the same canonical
// shape `openclaw config set` accepts) against the loaded config object.
function readPluginConfig(config: any, dotted: string): unknown {
  const m = /^plugins\.entries\.([^.]+)\.config\.(.+)$/.exec(dotted);
  if (!m) return undefined;
  const [, id, rest] = m;
  let node = config?.plugins?.entries?.[id!]?.config;
  for (const key of rest!.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

function pluginInstalled(config: any, id: string, artifact?: StatusArtifact): boolean {
  if (artifact) return true;
  const entry = config?.plugins?.entries?.[id];
  if (entry && entry.enabled !== false) return true;
  return Array.isArray(config?.plugins?.allow) && config.plugins.allow.includes(id);
}

function modelAllowlist(config: any): string[] {
  const m = config?.agents?.defaults?.models;
  if (Array.isArray(m)) return m.filter((x) => typeof x === "string");
  if (m && Array.isArray(m.allow)) return m.allow.filter((x: unknown) => typeof x === "string");
  return [];
}

// `openclaw cron list --json` prints `{ jobs: [...] }` (it queries the running
// gateway). Accept a bare array too, for resilience.
export function parseCronListJson(stdout: string): any[] {
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed;
    return parsed?.jobs ?? [];
  } catch { /* fall through to noise-tolerant extraction */ }

  // CLI startup noise (migration warnings, banners) can wrap the payload:
  // extract from each JSON opener to its last closer, but only accept a slice
  // that actually yields a job list — noise like "[state-migrations]" or a
  // jobs-less object fragment must not read as an empty listing.
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = stdout.indexOf(open);
    const end = stdout.lastIndexOf(close);
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.jobs)) return parsed.jobs;
    } catch { /* try the other opener */ }
  }
  return [];
}

// The cron *service* (api.runtime.cron) is only wired in the running gateway, not
// in the standalone CLI process the doctor runs in. Shell out to the CLI command,
// which talks to the gateway — the same path the user runs by hand.
// Failure here must stay distinguishable from "no jobs": the production
// incident was this exec failing (gateway unreachable from the doctor's exec
// context) and an empty catch turning that into "not registered" for every
// cron — with --fix then offering to mint duplicates.
async function listCronJobs(): Promise<{ ok: true; jobs: any[] } | { ok: false; error: string }> {
  try {
    const { stdout } = await exec("openclaw", ["cron", "list", "--all", "--json"]);
    return { ok: true, jobs: parseCronListJson(stdout) };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = [e.stderr?.trim(), e.stdout?.trim(), e.message].filter(Boolean).join(" | ").slice(0, 500);
    return { ok: false, error: detail || String(err) };
  }
}

// `openclaw --version` rather than a config read: what matters is the binary
// the gateway is actually running, and it is the same command a user would run
// to answer the question themselves.
async function readHostVersion(): Promise<HostVersionObservation> {
  try {
    const { stdout } = await exec("openclaw", ["--version"]);
    const raw = stdout.trim();
    const version = parseHostVersion(raw);
    return version ? { version, raw } : { raw, error: "could not parse a version from `openclaw --version`" };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { error: (e.stderr?.trim() || e.message || String(err)).slice(0, 300) };
  }
}

export function toCronObservation(base: string, jobs: any[]): CronObservation {
  // Exact name wins; prefix matches (multi-agent "-<agent>" suffixes, but also
  // legacy jobs like "sapience-thinking-pass") are fallbacks. Extra matches are
  // surfaced so leftover legacy jobs can't silently shadow the real one.
  const matches = jobs.filter((j) => j?.name === base || (typeof j?.name === "string" && j.name.startsWith(`${base}-`)));
  const job = matches.find((j) => j.name === base) ?? matches[0];
  if (!job) return { base };
  const extraMatches = matches.filter((j) => j !== job).map((j) => j.name as string);
  const st = job.state ?? {};
  return {
    base,
    job: {
      ...(typeof job.id === "string" ? { id: job.id } : {}),
      name: job.name,
      enabled: job.enabled !== false,
      payloadModel: job.payload?.model,
      lastStatus: st.lastRunStatus ?? st.lastStatus,
      consecutiveErrors: st.consecutiveErrors ?? 0,
      toolsAllow: Array.isArray(job.payload?.toolsAllow) ? job.payload.toolsAllow : undefined,
      ...(typeof job.declarationKey === "string" ? { declarationKey: job.declarationKey } : {}),
      announces: job.delivery?.mode === "announce",
      ...(typeof job.delivery?.channel === "string" && job.delivery.channel !== "last"
        ? { deliveryChannel: job.delivery.channel } : {}),
      ...(typeof job.delivery?.to === "string" && job.delivery.to
        ? { deliveryTo: job.delivery.to } : {}),
      ...(typeof job.payload?.message === "string" ? { message: job.payload.message } : {}),
      isCommandPayload: isCommandPayload(job),
    },
    ...(extraMatches.length > 0 ? { extraMatches } : {}),
  };
}

// Command payloads run a process, never an agent turn. openclaw has labelled
// the payload kind differently across versions, so recognize the argv/command
// fields too rather than trusting one spelling.
function isCommandPayload(job: any): boolean {
  const payload = job?.payload ?? {};
  return job?.payloadKind === "command" || payload.kind === "command" ||
    Array.isArray(payload.argv) || typeof payload.command === "string";
}

// Jobs from the suite's earlier naming generation ("sapience-thinking-pass" and
// friends). They are not just cosmetic duplicates: that generation shipped
// `delivery: { mode: "announce" }` together with prompts that told the model to
// reply with the literal string "SILENT_REPLY_TOKEN" — a token the runtime does
// not recognize — so on openclaw 2026.8+ they announce on every run. Because
// the rename was never a migration, an install that upgraded across it keeps
// running them alongside the current jobs.
export const LEGACY_CRON_SUFFIX = "-pass";

// `openclaw cron rm` takes a job id positionally; there is no --name option on
// it (verified in both 2026.7.1 and 2026.8.x — only `cron add` has --name), and
// the gateway's cron.remove rejects anything that is not an id with
// "id not found". Deletes must therefore resolve the name first.
//
// Returns every id, not the first: a job name is not unique, and duplicates are
// exactly what the delete paths exist to clean up. Deleting one of two copies
// would leave the other running on its original schedule and delivery route.
export function resolveCronJobIds(jobs: any[], name: string): string[] {
  return jobs
    .filter((j) => j?.name === name && typeof j?.id === "string" && j.id)
    .map((j) => j.id as string);
}

export function findLegacySuiteCronJobs(jobs: any[], bases: readonly string[]): string[] {
  return jobs
    .filter((j) => typeof j?.name === "string" &&
      bases.some((base) => j.name === `${base}${LEGACY_CRON_SUFFIX}` ||
        j.name.startsWith(`${base}${LEGACY_CRON_SUFFIX}-`)))
    .map((j) => j.name as string);
}

// Jobs outside the suite whose stored tool policy carries suite tool names.
// The benign explanation is openclaw's documented behavior — "jobs created by
// an agent are capped to the tools available to that creating turn", so a job
// created while the suite's tools were loaded snapshots all of them. The
// alternative, the suite widening a third-party job's policy, would be a
// permissions problem. Reporting the list is what tells the two apart.
export function findForeignJobsCarryingSuiteTools(
  jobs: any[],
  suiteBases: readonly string[],
  suiteTools: readonly string[],
): string[] {
  const isSuiteJob = (name: string) =>
    suiteBases.some((base) => name === base || name.startsWith(`${base}-`));
  return jobs
    .filter((j) => {
      const name = typeof j?.name === "string" ? j.name : "";
      if (!name || isSuiteJob(name)) return false;
      const allow = Array.isArray(j?.payload?.toolsAllow) ? j.payload.toolsAllow : [];
      return allow.some((t: unknown) => typeof t === "string" && suiteTools.includes(t));
    })
    .map((j) => j.name as string);
}

// ── filesystem scans for version skew and quarantined state ────────────────

// OpenClaw installs each plugin into <state>/npm/projects/<pkg>-<hash>/node_modules/…
// That copy is what loads on the next gateway restart.
export async function scanInstalledVersions(stateBase: string, pluginIds: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const projects = await readdir(join(stateBase, "npm", "projects"));
    for (const id of pluginIds) {
      const dir = projects.find((d) => d.startsWith(`akalsey-${id}-`));
      if (!dir) continue;
      try {
        const pkg = JSON.parse(await readFile(
          join(stateBase, "npm", "projects", dir, "node_modules", "@akalsey", id, "package.json"), "utf-8"));
        if (typeof pkg.version === "string") out[id] = pkg.version;
      } catch { /* unreadable install */ }
    }
  } catch { /* no npm/projects dir */ }
  return out;
}

// A stale legacy install at <state>/npm/package.json pins old versions that
// the gateway does NOT load — harmless at runtime, poisonous while debugging.
export async function readLegacyRootPins(stateBase: string, pluginIds: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(join(stateBase, "npm", "package.json"), "utf-8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const id of pluginIds) {
      const pin = deps[`@akalsey/${id}`];
      if (typeof pin === "string") out[id] = pin;
    }
  } catch { /* no legacy root install */ }
  return out;
}

// Outstanding proposal queue: count + oldest pending record from the outcome
// tracker, so the doctor can show the human what's silently waiting on them.
export async function readPendingProposals(workspaceDir: string): Promise<{ count: number; oldestAt?: string }> {
  try {
    const raw = JSON.parse(await readFile(join(workspaceDir, "proactive-thinking", "outcomes.json"), "utf-8"));
    const pending = Object.values(raw as Record<string, { state?: string; created_at?: string }>)
      .filter((r) => r?.state === "pending");
    const oldest = pending
      .map((r) => r.created_at)
      .filter((t): t is string => typeof t === "string")
      .sort()[0];
    return { count: pending.length, ...(oldest ? { oldestAt: oldest } : {}) };
  } catch {
    return { count: 0 };
  }
}

// safe-json quarantines unparseable state files as <name>.corrupt-<ts> —
// durable evidence a state file was corrupted and reset.
export async function findCorruptFiles(workspaceDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const sub of ["sapience", "proactive-thinking", "goals"]) {
    try {
      const entries = await readdir(join(workspaceDir, sub));
      for (const e of entries) {
        if (e.includes(".corrupt-")) found.push(join(workspaceDir, sub, e));
      }
    } catch { /* dir absent */ }
  }
  return found;
}

// Best-effort registry check; failures (offline, slow) return {}.
export async function fetchRegistryVersions(pluginIds: readonly string[], timeoutMs = 2500): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(pluginIds.map(async (id) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`https://registry.npmjs.org/@akalsey%2f${id}/latest`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      const body = await res.json() as { version?: string };
      if (typeof body.version === "string") out[id] = body.version;
    } catch { /* offline or slow: skip */ }
  }));
  return out;
}

// Names granted back to every session via tools.allow/alsoAllow (e.g.
// "group:plugins", or a specific tool name past an excluding profile).
function toolGrants(tools: any): string[] {
  return [...(Array.isArray(tools?.allow) ? tools.allow : []), ...(Array.isArray(tools?.alsoAllow) ? tools.alsoAllow : [])];
}

// Whether the gateway config exposes plugin tools to every session. A tools
// profile (other than "full") filters out plugin-registered tools unless
// tools.allow/alsoAllow grants them back — group:plugins covers all of them.
export function pluginToolsAllowedGlobally(config: any): boolean {
  const tools = config?.tools;
  const profile = tools?.profile;
  if (!profile || profile === "full") return true;
  return toolGrants(tools).includes("group:plugins");
}

// Which of core's goal tools an agent session can actually still call. `deny`
// wins over both the profile and the allow lists (documented precedence), so a
// denied tool is gone regardless of how it was granted.
export function goalToolCollision(config: any): GoalToolCollisionObservation {
  const tools = config?.tools;
  const profile = typeof tools?.profile === "string" ? tools.profile : undefined;
  const deny = Array.isArray(tools?.deny) ? tools.deny.filter((t: unknown) => typeof t === "string") : [];
  const grants = new Set(toolGrants(tools));
  // No profile means no filtering at all. A profile that excludes goals can still
  // have them granted back by name through allow/alsoAllow.
  const inProfile = !profile || GOAL_TOOL_PROFILES.includes(profile);
  return {
    goalsPluginInstalled: pluginInstalled(config, "sapience-goals"),
    ...(profile !== undefined ? { profile } : {}),
    deny,
    reachable: CORE_GOAL_TOOLS.filter((t) => !deny.includes(t) && (inProfile || grants.has(t))),
  };
}

function resolveWorkspace(api: any, config: any, artifacts: Record<string, StatusArtifact>): WorkspaceObservation {
  const observed = Object.values(artifacts)[0];
  // The artifact records the dir the plugin actually resolved at runtime — that's
  // ground truth for where files are written, so trust it directly. (We don't
  // recompute via resolveAgentWorkspaceDir: the runtime resolution is itself a
  // single-arg call, so there's no consistent agentId to compare against, and a
  // recomputation produced false "paths inconsistent" warnings.)
  if (observed) {
    return { resolved: observed.resolvedWorkspaceDir, source: "artifact" };
  }
  let resolved: string | undefined;
  try {
    const agentId = api?.runtime?.cron?.getDefaultAgentId?.() ?? "default";
    resolved = api?.runtime?.agent?.resolveAgentWorkspaceDir?.(config, agentId);
  } catch { /* resolver unavailable */ }
  return { resolved: resolved ?? "(unknown)", source: "resolver" };
}

async function fileObservation(label: string, workspaceDir: string, staleAfterMs?: number): Promise<FileObservation> {
  const path = join(workspaceDir, label);
  try {
    const s = await stat(path);
    return { label, path, exists: true, mtimeMs: s.mtimeMs, ...(staleAfterMs !== undefined ? { staleAfterMs } : {}) };
  } catch {
    return { label, path, exists: false };
  }
}

function memoryObservation(config: any): MemoryObservation {
  // Drive the reads from MEMORY_SETTINGS so the config paths live in one place.
  const obs: MemoryObservation = { wikiInstalled: pluginInstalled(config, "memory-wiki") };
  const writable = obs as unknown as Record<string, unknown>;
  for (const s of MEMORY_SETTINGS) {
    writable[s.key] = readPluginConfig(config, s.path);
  }
  return obs;
}

// Operator conversations in the session store: agent:<id>:<channel>:<rest...>
// keys — machine sessions (main/current, cron:*, subagent:*, custom labels)
// have fewer segments or a machine namespace.
// Mirrors isNoticeableSession in sapience-thinking/src/noticer.ts — the same
// structural rule applies (operator vs machine) in a different context (delivery
// target selection vs turn-watching). No shared lib; the duplication is intentional.
function isOperatorSessionKey(key: string): boolean {
  const parts = key.split(":");
  if (parts.length < 4 || parts[0] !== "agent") return false;
  return parts[2] !== "cron" && parts[2] !== "subagent";
}

async function gatherDeliveryTarget(config: any, stateBase: string): Promise<DoctorInputs["deliveryTarget"]> {
  const dmScope = config?.session?.dmScope;
  const configuredKeys: Record<string, string | undefined> = {};
  for (const id of DELIVERING_PLUGINS) {
    const v = readPluginConfig(config, `plugins.entries.${id}.config.delivery.sessionKey`);
    configuredKeys[id] = typeof v === "string" && v.trim() ? v.trim() : undefined;
  }
  const agents: any[] = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const agentId = String(agents.find((a) => a?.default)?.id ?? agents[0]?.id ?? "main").toLowerCase();
  let store: Record<string, { updatedAt?: number } | string> = {};
  try {
    store = JSON.parse(await readFile(join(stateBase, "agents", agentId, "sessions", "sessions.json"), "utf-8"));
  } catch { /* store absent or unreadable — report what we know */ }
  const keys = Object.keys(store);
  const candidateSessions = keys
    .filter(isOperatorSessionKey)
    .map((key) => {
      const entry = store[key];
      return { key, updatedAt: typeof entry === "object" && entry ? entry.updatedAt : undefined };
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 10);
  const configured = Object.values(configuredKeys).find((v) => v);
  return {
    dmScope: typeof dmScope === "string" ? dmScope : undefined,
    configuredKeys,
    candidateSessions,
    ...(configured && keys.length > 0 ? { configuredKeyExists: keys.includes(configured) } : {}),
  };
}

export async function gatherInputs(deps: { api: any; config: any; env?: NodeJS.ProcessEnv; nowMs: number }): Promise<DoctorInputs> {
  const { api, config, env, nowMs } = deps;
  const artifacts = await readStatusArtifacts(env);
  const listing = await listCronJobs();
  const jobs = listing.ok ? listing.jobs : [];

  const plugins: PluginObservation[] = SUITE_PLUGINS.map((id) => {
    const artifact = artifacts[id];
    return { id, installed: pluginInstalled(config, id, artifact), artifact };
  });

  const workspace = resolveWorkspace(api, config, artifacts);
  const files = await Promise.all(SUITE_FILES.map((f) => fileObservation(f.label, workspace.resolved, f.staleAfterMs)));

  const stateBase = resolveStateBase(env);
  const [onDisk, legacyPins, registry, corruptFiles, pendingProposals] = await Promise.all([
    scanInstalledVersions(stateBase, SUITE_PLUGINS),
    readLegacyRootPins(stateBase, SUITE_PLUGINS),
    fetchRegistryVersions(SUITE_PLUGINS),
    findCorruptFiles(workspace.resolved),
    readPendingProposals(workspace.resolved),
  ]);
  const versions: VersionObservation[] = SUITE_PLUGINS.map((id) => ({
    pluginId: id,
    running: artifacts[id]?.version && artifacts[id]!.version !== "unknown" ? artifacts[id]!.version : undefined,
    onDisk: onDisk[id],
    registryLatest: registry[id],
    // Only flag the legacy pin when it disagrees with the real install.
    legacyRootPin: legacyPins[id] && legacyPins[id] !== onDisk[id] ? legacyPins[id] : undefined,
  }));

  return {
    nowMs,
    plugins,
    crons: listing.ok ? ALL_SUITE_CRON_BASES.map((base) => toCronObservation(base, jobs)) : [],
    cronListing: listing.ok ? { available: true } : { available: false, error: listing.error },
    host: await readHostVersion(),
    legacyCronJobs: listing.ok ? findLegacySuiteCronJobs(jobs, SUITE_CRON_BASES) : [],
    foreignJobsWithSuiteTools: listing.ok
      ? findForeignJobsCarryingSuiteTools(jobs, ALL_SUITE_CRON_BASES, SUITE_TOOL_NAMES)
      : [],
    modelAllowlist: modelAllowlist(config),
    pluginToolsAllowedGlobally: pluginToolsAllowedGlobally(config),
    goalToolCollision: goalToolCollision(config),
    versions,
    corruptFiles,
    pendingProposals,
    workspace,
    files,
    memory: memoryObservation(config),
    deliveryTarget: await gatherDeliveryTarget(config, stateBase),
  };
}

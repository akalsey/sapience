import { stat, readdir, readFile } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { readStatusArtifacts, resolveStateBase } from "../status-artifact.js";
import { SUITE_PLUGINS, SUITE_CRON_BASES, SUITE_FILES, MEMORY_SETTINGS } from "./inventory.js";
import type {
  DoctorInputs,
  PluginObservation,
  CronObservation,
  FileObservation,
  WorkspaceObservation,
  MemoryObservation,
  StatusArtifact,
  VersionObservation,
} from "./types.js";

const exec = promisify(execFile);

// Reads a dotted "plugins.<id>.<rest>" path against the real OpenClawConfig shape
// (config.plugins.entries.<id>.config.<rest>). Returns undefined if absent.
function readPluginConfig(config: any, dotted: string): unknown {
  const m = /^plugins\.([^.]+)\.(.+)$/.exec(dotted);
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
    },
    ...(extraMatches.length > 0 ? { extraMatches } : {}),
  };
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

// Whether the gateway config exposes plugin tools to every session. A tools
// profile (other than "full") filters out plugin-registered tools unless
// tools.allow/alsoAllow grants them back — group:plugins covers all of them.
export function pluginToolsAllowedGlobally(config: any): boolean {
  const tools = config?.tools;
  const profile = tools?.profile;
  if (!profile || profile === "full") return true;
  const grants = [...(Array.isArray(tools?.allow) ? tools.allow : []), ...(Array.isArray(tools?.alsoAllow) ? tools.alsoAllow : [])];
  return grants.includes("group:plugins");
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
  const [onDisk, legacyPins, registry, corruptFiles] = await Promise.all([
    scanInstalledVersions(stateBase, SUITE_PLUGINS),
    readLegacyRootPins(stateBase, SUITE_PLUGINS),
    fetchRegistryVersions(SUITE_PLUGINS),
    findCorruptFiles(workspace.resolved),
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
    crons: listing.ok ? SUITE_CRON_BASES.map((base) => toCronObservation(base, jobs)) : [],
    cronListing: listing.ok ? { available: true } : { available: false, error: listing.error },
    modelAllowlist: modelAllowlist(config),
    pluginToolsAllowedGlobally: pluginToolsAllowedGlobally(config),
    versions,
    corruptFiles,
    workspace,
    files,
    memory: memoryObservation(config),
  };
}

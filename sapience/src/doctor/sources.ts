import { stat } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { readStatusArtifacts } from "../status-artifact.js";
import { SUITE_PLUGINS, SUITE_CRON_BASES, SUITE_FILES, MEMORY_SETTINGS } from "./inventory.js";
import type {
  DoctorInputs,
  PluginObservation,
  CronObservation,
  FileObservation,
  WorkspaceObservation,
  MemoryObservation,
  StatusArtifact,
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
  } catch {
    return [];
  }
}

// The cron *service* (api.runtime.cron) is only wired in the running gateway, not
// in the standalone CLI process the doctor runs in. Shell out to the CLI command,
// which talks to the gateway — the same path the user runs by hand.
async function listCronJobs(): Promise<any[]> {
  try {
    const { stdout } = await exec("openclaw", ["cron", "list", "--all", "--json"]);
    return parseCronListJson(stdout);
  } catch {
    return [];
  }
}

function toCronObservation(base: string, jobs: any[]): CronObservation {
  const job = jobs.find((j) => j?.name === base || (typeof j?.name === "string" && j.name.startsWith(`${base}-`)));
  if (!job) return { base };
  const st = job.state ?? {};
  return {
    base,
    job: {
      name: job.name,
      enabled: job.enabled !== false,
      payloadModel: job.payload?.model,
      lastStatus: st.lastRunStatus ?? st.lastStatus,
      consecutiveErrors: st.consecutiveErrors ?? 0,
    },
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

async function fileObservation(label: string, workspaceDir: string): Promise<FileObservation> {
  const path = join(workspaceDir, label);
  try {
    const s = await stat(path);
    return { label, path, exists: true, mtimeMs: s.mtimeMs };
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
  const jobs = await listCronJobs();

  const plugins: PluginObservation[] = SUITE_PLUGINS.map((id) => {
    const artifact = artifacts[id];
    return { id, installed: pluginInstalled(config, id, artifact), artifact };
  });

  const workspace = resolveWorkspace(api, config, artifacts);
  const files = await Promise.all(SUITE_FILES.map((f) => fileObservation(f.label, workspace.resolved)));

  return {
    nowMs,
    plugins,
    crons: SUITE_CRON_BASES.map((base) => toCronObservation(base, jobs)),
    modelAllowlist: modelAllowlist(config),
    workspace,
    files,
    memory: memoryObservation(config),
  };
}

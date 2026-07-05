import { homedir } from "os";
import { join } from "path";
import { mkdir, writeFile, readFile, readdir } from "fs/promises";
import { createRequire } from "node:module";
import type { StatusArtifact } from "./doctor/types.js";

// Reads this plugin's own version from its package.json. api.plugin/api.manifest
// are not populated at register() time, so this is the reliable source.
export function resolvePluginVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    return (req("../../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// Mirrors openclaw's resolveStateDir for the common case: OPENCLAW_STATE_DIR
// override, else ~/.openclaw. Both the writer (each suite plugin, at init) and the
// doctor reader call this, so the artifact location is always consistent between
// them — deliberately independent of workspace-dir resolution (which is the thing
// the doctor is meant to verify, so it can't be trusted to locate the artifacts).
// The openclaw state dir (OPENCLAW_STATE_DIR override, else ~/.openclaw). Also
// used by the doctor's version-skew scans over <state>/npm.
export function resolveStateBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override && override.length > 0) {
    return override.startsWith("~/") ? join(homedir(), override.slice(2)) : override;
  }
  return join(homedir(), ".openclaw");
}

export function resolveStatusDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStateBase(env), "sapience", "status");
}

export async function writeStatusArtifact(a: StatusArtifact, env?: NodeJS.ProcessEnv): Promise<void> {
  const dir = resolveStatusDir(env);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${a.pluginId}.json`), JSON.stringify(a, null, 2), "utf-8");
}

export async function readStatusArtifacts(env?: NodeJS.ProcessEnv): Promise<Record<string, StatusArtifact>> {
  const dir = resolveStatusDir(env);
  const out: Record<string, StatusArtifact> = {};
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const a = JSON.parse(await readFile(join(dir, f), "utf-8")) as StatusArtifact;
      if (a?.pluginId) out[a.pluginId] = a;
    } catch {
      /* skip corrupt artifact */
    }
  }
  return out;
}

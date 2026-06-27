import { homedir } from "os";
import { join } from "path";
import { mkdir, writeFile, readFile, readdir } from "fs/promises";
import type { StatusArtifact } from "./doctor/types.js";

// Mirrors openclaw's resolveStateDir for the common case: OPENCLAW_STATE_DIR
// override, else ~/.openclaw. Both the writer (each suite plugin, at init) and the
// doctor reader call this, so the artifact location is always consistent between
// them — deliberately independent of workspace-dir resolution (which is the thing
// the doctor is meant to verify, so it can't be trusted to locate the artifacts).
export function resolveStatusDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  const base =
    override && override.length > 0
      ? override.startsWith("~/")
        ? join(homedir(), override.slice(2))
        : override
      : join(homedir(), ".openclaw");
  return join(base, "sapience", "status");
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

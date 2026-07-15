import { homedir } from "os";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { createRequire } from "node:module";

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

// Status artifact written at init so `openclaw sapience doctor` can report what this
// plugin actually resolved (not a recomputation). The shape must match the sapience
// plugin's StatusArtifact — the doctor reads these. Mirrors openclaw's
// resolveStateDir for the common case (OPENCLAW_STATE_DIR override, else ~/.openclaw),
// deliberately independent of workspace-dir resolution.
export interface StatusArtifact {
  pluginId: string;
  version: string;
  agentId: string;
  resolvedWorkspaceDir: string;
  outputPaths: Record<string, string>;
  // How passive feedback capture registered: "message-hook" when the gateway
  // exposes registerHook, "command-only" when only /feedback works.
  captureMode?: "message-hook" | "command-only";
  // Set when register() failed in a real gateway runtime.
  initError?: string;
  initAt: string;
}

function resolveStatusDir(env: NodeJS.ProcessEnv = process.env): string {
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

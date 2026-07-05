import { stat } from "fs/promises";
import { join } from "path";

export const PRESENCE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// sapience touches <workspace>/sapience/.present on every routing run. A stale
// marker means the router is gone (uninstalled or disabled) — thinking must
// fall back to its own delivery instead of orphaning proposals forever, which
// is what a plain existence check did.
export async function isSapienceActive(workspaceDir: string, maxAgeMs: number = PRESENCE_MAX_AGE_MS): Promise<boolean> {
  try {
    const s = await stat(join(workspaceDir, "sapience", ".present"));
    return Date.now() - s.mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { dirname } from "path";

// A thinking pass runs in an isolated cron session with a 120s timeout, so any
// lock older than this belongs to a pass that never called
// record_thinking_output (model stopped, session timed out). Steal it silently.
//
// Never signal the stored pid: plugins run in-process, so the pid is the
// gateway's own — the previous implementation SIGKILLed the gateway from
// inside itself when recovering a stale lock.
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

interface LockData {
  pid: number;
  started_at: string;
}

export async function acquireLock(lockFile: string, staleMs: number = DEFAULT_LOCK_STALE_MS): Promise<boolean> {
  await mkdir(dirname(lockFile), { recursive: true });
  try {
    const lock = JSON.parse(await readFile(lockFile, "utf-8")) as LockData;
    const age = Date.now() - new Date(lock.started_at).getTime();
    if (Number.isFinite(age) && age < staleMs) return false;
  } catch { /* missing or corrupt lock — take it */ }

  await writeFile(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), "utf-8");
  return true;
}

export async function releaseLock(lockFile: string): Promise<void> {
  try { await unlink(lockFile); } catch { /* already gone */ }
}

// A gateway restart means no pass can be running; drop any leftover lock so
// the first pass after boot doesn't wait out the stale window.
export async function clearLock(lockFile: string): Promise<void> {
  await releaseLock(lockFile);
}

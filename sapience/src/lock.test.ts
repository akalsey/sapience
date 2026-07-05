import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, access } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { acquireLock, releaseLock, clearLock, DEFAULT_LOCK_STALE_MS } from "./lock.js";

let tmpDir: string;
let lockFile: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lock-test-"));
  lockFile = join(tmpDir, "sub", ".pass.lock");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("acquires when no lock exists, creating parent dirs", async () => {
    expect(await acquireLock(lockFile)).toBe(true);
    const lock = JSON.parse(await readFile(lockFile, "utf-8"));
    expect(lock.pid).toBe(process.pid);
    expect(typeof lock.started_at).toBe("string");
  });

  it("refuses while a fresh lock is held", async () => {
    expect(await acquireLock(lockFile)).toBe(true);
    expect(await acquireLock(lockFile)).toBe(false);
  });

  it("silently steals a stale lock without signalling any process", async () => {
    // The stale lock belongs to a live pid — our own. The old implementation
    // SIGTERM/SIGKILLed the stored pid, which is the gateway's own pid since
    // plugins run in-process. Surviving this call is the regression test.
    await acquireLock(lockFile);
    const stale = { pid: process.pid, started_at: new Date(Date.now() - DEFAULT_LOCK_STALE_MS - 1000).toISOString() };
    await writeFile(lockFile, JSON.stringify(stale), "utf-8");
    expect(await acquireLock(lockFile)).toBe(true);
  });

  it("treats a corrupt lock file as absent", async () => {
    await acquireLock(lockFile);
    await writeFile(lockFile, "{not json", "utf-8");
    expect(await acquireLock(lockFile)).toBe(true);
  });

  it("honors a custom stale threshold", async () => {
    await acquireLock(lockFile);
    const aged = { pid: process.pid, started_at: new Date(Date.now() - 5000).toISOString() };
    await writeFile(lockFile, JSON.stringify(aged), "utf-8");
    expect(await acquireLock(lockFile, 1000)).toBe(true);
  });
});

describe("releaseLock", () => {
  it("removes the lock file and tolerates a missing one", async () => {
    await acquireLock(lockFile);
    await releaseLock(lockFile);
    await expect(access(lockFile)).rejects.toThrow();
    await releaseLock(lockFile); // no throw
  });
});

describe("clearLock", () => {
  it("removes a leftover lock so a gateway restart starts clean", async () => {
    await acquireLock(lockFile);
    await clearLock(lockFile);
    expect(await acquireLock(lockFile)).toBe(true);
  });
});

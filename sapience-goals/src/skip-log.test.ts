import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { logSkipOnce, clearSkipState } from "./skip-log.js";

let dir: string;
let statePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skip-log-"));
  statePath = join(dir, "skip-state.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("logSkipOnce", () => {
  // An overnight install used to write an outside_hours skip event every 15
  // minutes, all night, every night — pure noise. Log once per transition.
  it("logs the first occurrence of a reason but not repeats", async () => {
    let logged = 0;
    await logSkipOnce(statePath, "outside_hours", async () => { logged++; });
    await logSkipOnce(statePath, "outside_hours", async () => { logged++; });
    await logSkipOnce(statePath, "outside_hours", async () => { logged++; });
    expect(logged).toBe(1);
  });

  it("logs again after the state is cleared (a successful run happened)", async () => {
    let logged = 0;
    await logSkipOnce(statePath, "outside_hours", async () => { logged++; });
    await clearSkipState(statePath);
    await logSkipOnce(statePath, "outside_hours", async () => { logged++; });
    expect(logged).toBe(2);
  });

  it("logs when the reason changes", async () => {
    const reasons: string[] = [];
    await logSkipOnce(statePath, "outside_hours", async () => { reasons.push("outside_hours"); });
    await logSkipOnce(statePath, "already_running", async () => { reasons.push("already_running"); });
    expect(reasons).toEqual(["outside_hours", "already_running"]);
  });
});

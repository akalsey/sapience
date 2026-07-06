import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parseWatchValue, checkDueWatches } from "./watch-checker.js";
import { addWatch, loadWatches, recordReading } from "./watches.js";
import { DEFAULT_CONFIG } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "watch-check-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function makeApi(finalText: string) {
  const injections: string[] = [];
  const heartbeats: any[] = [];
  return {
    injections, heartbeats,
    config: {},
    session: {
      workflow: {
        enqueueNextTurnInjection: async (inj: { sessionKey: string; text: string }) => {
          injections.push(inj.text);
          return { enqueued: true, id: "1", sessionKey: inj.sessionKey };
        },
      },
    },
    runtime: {
      system: { requestHeartbeat: (o: any) => heartbeats.push(o) },
      subagent: {
        run: async () => ({ runId: "r1" }),
        waitForRun: async () => ({ status: "ok" }),
        getSessionMessages: async () => ({
          messages: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: finalText }] } }],
        }),
        deleteSession: async () => {},
      },
    },
  };
}

function config() {
  return {
    ...DEFAULT_CONFIG,
    push: { ...DEFAULT_CONFIG.push, enabled: true, maxPerDay: 10, minPriority: 4 },
    output: {
      ...DEFAULT_CONFIG.output,
      eventsPath: join(dir, "events.jsonl"),
      watchesPath: join(dir, "watches.json"),
      pushStatePath: join(dir, "push-state.json"),
    },
  } as any;
}

const spec = { name: "signups", query_hint: "salesforce", cadence_hours: 24, delta_policy: { kind: "percent" as const, threshold: 20 } };

describe("parseWatchValue", () => {
  it("extracts the numeric value", () => {
    expect(parseWatchValue('checked.\n{"value": 42.5}')).toBe(42.5);
  });
  it("returns null for unfetchable or garbage", () => {
    expect(parseWatchValue('{"value": null, "reason": "no access"}')).toBeNull();
    expect(parseWatchValue("nope")).toBeNull();
  });
});

describe("checkDueWatches", () => {
  it("fetches due watches, records readings, and stays quiet inside the threshold", async () => {
    const cfg = config();
    const w = await addWatch(cfg.output.watchesPath, spec);
    await recordReading(cfg.output.watchesPath, w.id, 100);
    await recordReading(cfg.output.watchesPath, w.id, 102);
    // Force due again
    const list = await loadWatches(cfg.output.watchesPath);
    const { writeFile } = await import("fs/promises");
    await writeFile(cfg.output.watchesPath, JSON.stringify(list.map((x) => ({ ...x, last_checked: "2026-01-01T00:00:00Z" }))));

    const api = makeApi('{"value": 101}');
    await checkDueWatches(api, cfg);

    const [stored] = await loadWatches(cfg.output.watchesPath);
    expect(stored!.readings.map((r) => r.value)).toEqual([100, 102, 101]);
    expect(api.injections).toHaveLength(0); // steady: no surfacing

    const events = (await readFile(cfg.output.eventsPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "watch_checked" && e.notable === false)).toBe(true);
  });

  it("surfaces and pushes a notable move", async () => {
    const cfg = config();
    const w = await addWatch(cfg.output.watchesPath, spec);
    await recordReading(cfg.output.watchesPath, w.id, 100);
    await recordReading(cfg.output.watchesPath, w.id, 102);
    const list = await loadWatches(cfg.output.watchesPath);
    const { writeFile } = await import("fs/promises");
    await writeFile(cfg.output.watchesPath, JSON.stringify(list.map((x) => ({ ...x, last_checked: "2026-01-01T00:00:00Z" }))));

    const api = makeApi('{"value": 40}');
    await checkDueWatches(api, cfg);

    expect(api.injections).toHaveLength(1);
    expect(api.injections[0]).toContain("signups");
    expect(api.injections[0]).toContain("below");
    expect(api.heartbeats).toHaveLength(1);
  });

  it("records a failure without a reading when the value is unfetchable", async () => {
    const cfg = config();
    await addWatch(cfg.output.watchesPath, spec);
    const api = makeApi('{"value": null, "reason": "no salesforce access"}');
    await checkDueWatches(api, cfg);
    const [stored] = await loadWatches(cfg.output.watchesPath);
    expect(stored!.readings).toHaveLength(0);
    expect(stored!.last_checked).toBeDefined(); // no hammering on failure
    const events = (await readFile(cfg.output.eventsPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "watch_check_failed")).toBe(true);
  });

  it("does nothing when the subagent runtime is unavailable", async () => {
    const cfg = config();
    await addWatch(cfg.output.watchesPath, spec);
    await checkDueWatches({ config: {} }, cfg);
    const [stored] = await loadWatches(cfg.output.watchesPath);
    expect(stored!.last_checked).toBeUndefined();
  });
});

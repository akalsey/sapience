import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadWatches, addWatch, removeWatch, dueWatches, recordReading, evaluateReading, renderWatches } from "./watches.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "watches-"));
  path = join(dir, "watches.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const spec = {
  name: "daily signups",
  query_hint: "Salesforce signups report, last 24h",
  cadence_hours: 24,
  delta_policy: { kind: "percent" as const, threshold: 20 },
};

describe("watch registry", () => {
  it("adds, lists, and removes watches", async () => {
    const w = await addWatch(path, spec);
    expect(w.id).toBeDefined();
    expect((await loadWatches(path))).toHaveLength(1);
    await removeWatch(path, w.id);
    expect(await loadWatches(path)).toHaveLength(0);
  });

  it("rejects duplicate names", async () => {
    await addWatch(path, spec);
    await expect(addWatch(path, spec)).rejects.toThrow(/already/i);
  });
});

describe("dueWatches", () => {
  it("returns watches never checked or past their cadence", async () => {
    const w = await addWatch(path, spec);
    expect((await dueWatches(path)).map((x) => x.id)).toEqual([w.id]);
    await recordReading(path, w.id, 120);
    expect(await dueWatches(path)).toHaveLength(0);
  });
});

describe("evaluateReading", () => {
  const readings = (values: number[]) => values.map((value, i) => ({ at: `2026-06-0${i + 1}T00:00:00Z`, value }));

  it("is quiet without enough baseline history", () => {
    expect(evaluateReading(115, readings([120]), { kind: "percent", threshold: 20 }).notable).toBe(false);
  });

  it("flags a percent move beyond threshold vs the baseline mean", () => {
    const result = evaluateReading(40, readings([120, 118, 122]), { kind: "percent", threshold: 20 });
    expect(result.notable).toBe(true);
    expect(result.summary).toContain("40");
    expect(result.summary.toLowerCase()).toContain("below");
  });

  it("stays quiet inside the threshold", () => {
    expect(evaluateReading(115, readings([120, 118, 122]), { kind: "percent", threshold: 20 }).notable).toBe(false);
  });

  it("supports absolute-threshold crossings", () => {
    const up = evaluateReading(105, readings([90, 95]), { kind: "above", threshold: 100 });
    expect(up.notable).toBe(true);
    const down = evaluateReading(2.1, readings([3.5, 3.2]), { kind: "below", threshold: 2.5 });
    expect(down.notable).toBe(true);
  });

  it("'always' policy reports every reading", () => {
    expect(evaluateReading(120, [], { kind: "always" }).notable).toBe(true);
  });
});

describe("recordReading", () => {
  it("appends readings, keeps a bounded history, and stamps last_checked", async () => {
    const w = await addWatch(path, spec);
    for (let i = 0; i < 40; i++) await recordReading(path, w.id, 100 + i);
    const [stored] = await loadWatches(path);
    expect(stored!.readings.length).toBeLessThanOrEqual(30);
    expect(stored!.readings[stored!.readings.length - 1]!.value).toBe(139);
    expect(stored!.last_checked).toBeDefined();
  });
});

describe("renderWatches", () => {
  it("lists what is being watched with latest values", async () => {
    const w = await addWatch(path, spec);
    await recordReading(path, w.id, 120);
    const text = renderWatches(await loadWatches(path));
    expect(text).toContain("daily signups");
    expect(text).toContain("120");
  });

  it("says so when nothing is watched", () => {
    expect(renderWatches([])).toContain("No watches");
  });
});

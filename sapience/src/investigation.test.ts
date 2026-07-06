import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parseVerdict, investigateHunches } from "./investigation.js";
import type { RoutedItem } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "investigation-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const hunch: RoutedItem = {
  id: "h1", type: "observation", text: "spend velocity decays before churn",
  domain: "posthog", action_class: "observation", priority: 4,
  pass_id: "p1", pass_timestamp: "t", tier: "explore", confidence: 0.5,
  evidence_grade: "hunch",
};

function makeApi(finalText: string, waitStatus: "ok" | "error" | "timeout" = "ok") {
  const calls: any[] = [];
  return {
    calls,
    config: {},
    runtime: {
      subagent: {
        run: async (params: any) => { calls.push(["run", params]); return { runId: "r1" }; },
        waitForRun: async (params: any) => { calls.push(["wait", params]); return { status: waitStatus }; },
        getSessionMessages: async () => ({
          messages: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: finalText }] } }],
        }),
        deleteSession: async (params: any) => { calls.push(["delete", params]); },
      },
    },
  };
}

function config(overrides: Partial<typeof DEFAULT_CONFIG.investigation> = {}) {
  return {
    ...DEFAULT_CONFIG,
    investigation: { ...DEFAULT_CONFIG.investigation, ...overrides },
    output: { ...DEFAULT_CONFIG.output,
      eventsPath: join(dir, "events.jsonl"),
      investigationStatePath: join(dir, "investigation-state.json"),
      hypothesesPath: join(dir, "hypotheses.json"),
    },
  };
}

describe("parseVerdict", () => {
  it("extracts a verdict JSON object from assistant output", () => {
    const v = parseVerdict('Here is what I found.\n{"verdict":"supported","summary":"8 of 9 churned accounts fit","n":9}');
    expect(v.verdict).toBe("supported");
    expect(v.summary).toContain("8 of 9");
  });

  it("treats garbage or missing verdicts as inconclusive", () => {
    expect(parseVerdict("no json here").verdict).toBe("inconclusive");
    expect(parseVerdict('{"verdict":"who knows"}').verdict).toBe("inconclusive");
  });
});

describe("investigateHunches", () => {
  const reroute = (item: RoutedItem): RoutedItem => ({ ...item, tier: "propose" });

  it("upgrades a supported hunch to quick_check and re-routes it", async () => {
    const api = makeApi('{"verdict":"supported","summary":"pattern holds across 9 accounts"}');
    const out = await investigateHunches([hunch], api, config() as any, reroute);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence_grade).toBe("quick_check");
    expect(out[0]!.tier).toBe("propose");
    expect(out[0]!.text).toContain("pattern holds");
  });

  it("drops refuted hunches", async () => {
    const api = makeApi('{"verdict":"refuted","summary":"no correlation in the cohort"}');
    const out = await investigateHunches([hunch], api, config() as any, reroute);
    expect(out).toHaveLength(0);
  });

  it("keeps inconclusive hunches at their gated tier", async () => {
    const api = makeApi('{"verdict":"inconclusive","summary":"not enough data"}');
    const out = await investigateHunches([hunch], api, config() as any, reroute);
    expect(out).toHaveLength(1);
    expect(out[0]!.tier).toBe("explore");
    expect(out[0]!.evidence_grade).toBe("hunch");
  });

  it("passes through non-hunch and low-priority items untouched", async () => {
    const api = makeApi('{"verdict":"supported","summary":"x"}');
    const plain = { ...hunch, id: "p2", evidence_grade: undefined };
    const low = { ...hunch, id: "p3", priority: 1 };
    const out = await investigateHunches([plain, low], api, config({ minPriority: 3 }) as any, reroute);
    expect(out.map((i) => i.id)).toEqual(["p2", "p3"]);
    expect(api.calls.filter((c) => c[0] === "run")).toHaveLength(0);
  });

  it("respects the daily budget", async () => {
    const api = makeApi('{"verdict":"inconclusive","summary":"x"}');
    const cfg = config({ maxPerDay: 1 }) as any;
    await investigateHunches([hunch, { ...hunch, id: "h2" }], api, cfg, reroute);
    expect(api.calls.filter((c) => c[0] === "run")).toHaveLength(1);
  });

  it("constrains the subagent to read-only conduct and cleans up its session", async () => {
    const api = makeApi('{"verdict":"inconclusive","summary":"x"}');
    await investigateHunches([hunch], api, config() as any, reroute);
    const run = api.calls.find((c) => c[0] === "run")![1];
    expect(run.extraSystemPrompt.toLowerCase()).toContain("read-only");
    expect(api.calls.some((c) => c[0] === "delete")).toBe(true);
  });

  it("degrades gracefully when the subagent runtime is unavailable", async () => {
    const out = await investigateHunches([hunch], { config: {} }, config() as any, reroute);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence_grade).toBe("hunch");
  });
});

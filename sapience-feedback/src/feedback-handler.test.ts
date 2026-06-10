import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { classifyMessage, persistSignal, shouldClassify } from "./feedback-handler.js";
import type { LlmClient, FeedbackConfig, DetectedSignal } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

function makeClient(text: string): LlmClient {
  return { complete: vi.fn(async () => ({ text })) };
}

const CONFIG: FeedbackConfig = { ...DEFAULT_CONFIG };

describe("shouldClassify", () => {
  it("skips messages below minLength", () => {
    expect(shouldClassify("hi", CONFIG)).toBe(false);
    expect(shouldClassify("ok thanks", CONFIG)).toBe(true);
  });

  it("skips empty/whitespace-only messages", () => {
    expect(shouldClassify("", CONFIG)).toBe(false);
    expect(shouldClassify("   ", CONFIG)).toBe(false);
  });

  it("skips fenced code blocks", () => {
    expect(shouldClassify("```\nconst x = 1\n```", CONFIG)).toBe(false);
  });
});

describe("classifyMessage", () => {
  it("uses the LLM when a client is provided and semantic detection is enabled", async () => {
    const client = makeClient(JSON.stringify({
      signals: [{ type: "correction", domain: "credentials", action_class: "general", suggested_tier: null, confidence: 0.9 }],
    }));
    const signals = await classifyMessage("did you check the password manager", CONFIG, client);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.source).toBe("llm");
    expect(signals[0]!.domain).toBe("credentials");
  });

  it("falls back to regex when no LLM client is available", async () => {
    const signals = await classifyMessage("don't push to github main without asking", CONFIG, null);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.source).toBe("regex");
    expect(signals[0]!.domain).toBe("github");
  });

  it("falls back to regex when semantic detection is disabled", async () => {
    const client = makeClient(JSON.stringify({ signals: [{ type: "correction", domain: "x", action_class: "y", confidence: 0.9 }] }));
    const cfg: FeedbackConfig = { ...CONFIG, semanticDetection: { ...CONFIG.semanticDetection, enabled: false } };
    const signals = await classifyMessage("don't push to github main", cfg, client);
    expect(signals[0]?.source).toBe("regex");
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("falls back to regex when LLM call throws", async () => {
    const client: LlmClient = { complete: vi.fn(async () => { throw new Error("network"); }) };
    const signals = await classifyMessage("don't push to github main", CONFIG, client);
    expect(signals[0]?.source).toBe("regex");
  });

  it("returns empty signals for neutral chatter", async () => {
    const client = makeClient(JSON.stringify({ signals: [] }));
    const signals = await classifyMessage("what time is the standup tomorrow", CONFIG, client);
    expect(signals).toHaveLength(0);
  });

  it("does not call the LLM for messages below minLength", async () => {
    const client = makeClient(JSON.stringify({ signals: [] }));
    const signals = await classifyMessage("ok", CONFIG, client);
    expect(client.complete).not.toHaveBeenCalled();
    expect(signals).toHaveLength(0);
  });
});

describe("persistSignal", () => {
  it("writes a meta-pointer for corrections and calls memoryAdd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feedback-handler-"));
    const cfg: FeedbackConfig = {
      ...DEFAULT_CONFIG,
      logPath: join(dir, "feedback.md"),
      calibrationPath: join(dir, "calibration.json"),
    };
    const memoryAdd = vi.fn(async () => undefined);
    const signal: DetectedSignal = {
      type: "correction",
      domain: "credentials",
      action_class: "general",
      message: "always check the password manager",
      raw_text: "always check the password manager",
      source: "llm",
    };

    const entry = await persistSignal(signal, { config: cfg, memoryAdd });

    expect(entry.meta_pointer).toContain("credentials");
    expect(memoryAdd).toHaveBeenCalledOnce();
    const callArg = memoryAdd.mock.calls[0]![0] as { content: string; metadata: { tags: string[] } };
    expect(callArg.metadata.tags).toContain("credentials");
    const log = await readFile(cfg.logPath, "utf-8");
    expect(log).toContain("credentials");
    expect(log).toContain("correction");
  });

  it("does not call memoryAdd for confirmations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feedback-handler-"));
    const cfg: FeedbackConfig = {
      ...DEFAULT_CONFIG,
      logPath: join(dir, "feedback.md"),
      calibrationPath: join(dir, "calibration.json"),
    };
    const memoryAdd = vi.fn(async () => undefined);
    const signal: DetectedSignal = {
      type: "confirmation",
      domain: "general",
      action_class: "general",
      message: "yes that's right",
      raw_text: "yes that's right",
      source: "llm",
    };

    const entry = await persistSignal(signal, { config: cfg, memoryAdd });
    expect(entry.meta_pointer).toBeUndefined();
    expect(memoryAdd).not.toHaveBeenCalled();
  });

  it("skips memoryAdd when memoryEnabled is false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feedback-handler-"));
    const cfg: FeedbackConfig = {
      ...DEFAULT_CONFIG,
      logPath: join(dir, "feedback.md"),
      calibrationPath: join(dir, "calibration.json"),
      memoryEnabled: false,
    };
    const memoryAdd = vi.fn(async () => undefined);
    const signal: DetectedSignal = {
      type: "correction",
      domain: "credentials",
      action_class: "general",
      message: "always check the password manager",
      raw_text: "always check the password manager",
      source: "llm",
    };

    await persistSignal(signal, { config: cfg, memoryAdd });
    expect(memoryAdd).not.toHaveBeenCalled();
  });
});

describe("persistSignal event emission", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "feedback-events-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const baseConfig: FeedbackConfig = { ...DEFAULT_CONFIG };

  it("emits signal_detected and calibration_change events when applied", async () => {
    const eventsPath = join(dir, "events.jsonl");
    await writeFile(join(dir, "calibration.json"), JSON.stringify([
      { domain: "github", action_class: "general", tier: "propose", confidence: 0.6, confirmed_count: 0, corrected_count: 0, last_calibrated: "2026-01-01T00:00:00Z", notes: "" },
    ]), "utf-8");
    const config: FeedbackConfig = { ...baseConfig, eventsPath, calibrationPath: join(dir, "calibration.json"), logPath: join(dir, "feedback.md") };
    const signal: DetectedSignal = { type: "correction", domain: "github", action_class: "general", message: "don't", raw_text: "don't", source: "regex" };
    await persistSignal(signal, { config });
    const events = (await readFile(eventsPath, "utf-8")).trim().split("\n").map(l => JSON.parse(l));
    expect(events.map((e: any) => e.type)).toEqual(["signal_detected", "calibration_change"]);
    expect(events[1].source).toBe("feedback");
    expect(events[1].old_confidence).toBe(0.6);
  });

  it("emits signal_orphaned when no calibration entry matches", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const config: FeedbackConfig = { ...baseConfig, eventsPath, calibrationPath: join(dir, "missing.json"), logPath: join(dir, "feedback.md") };
    const signal: DetectedSignal = { type: "correction", domain: "nowhere", action_class: "general", message: "don't", raw_text: "don't", source: "regex" };
    await persistSignal(signal, { config });
    const events = (await readFile(eventsPath, "utf-8")).trim().split("\n").map(l => JSON.parse(l));
    expect(events.map((e: any) => e.type)).toEqual(["signal_detected", "signal_orphaned"]);
  });

  it("emits only signal_detected for a noop tier_adjustment", async () => {
    const eventsPath = join(dir, "events.jsonl");
    await writeFile(join(dir, "calibration.json"), JSON.stringify([
      { domain: "github", action_class: "general", tier: "propose", confidence: 0.6, confirmed_count: 0, corrected_count: 0, last_calibrated: "2026-01-01T00:00:00Z", notes: "" },
    ]), "utf-8");
    const config: FeedbackConfig = { ...baseConfig, eventsPath, calibrationPath: join(dir, "calibration.json"), logPath: join(dir, "feedback.md") };
    const signal: DetectedSignal = { type: "tier_adjustment", domain: "github", action_class: "general", message: "m", raw_text: "m", source: "regex" };
    await persistSignal(signal, { config });
    const events = (await readFile(eventsPath, "utf-8")).trim().split("\n").map(l => JSON.parse(l));
    expect(events.map((e: any) => e.type)).toEqual(["signal_detected"]);
  });
});

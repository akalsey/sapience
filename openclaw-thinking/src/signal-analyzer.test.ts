import { describe, it, expect } from "vitest";
import { computeSignal } from "./signal-analyzer.js";
import type { OutcomeMap, PluginConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

const config: PluginConfig = { ...DEFAULT_CONFIG, learning: { ...DEFAULT_CONFIG.learning, bootstrapDays: 14 } };

function makeRecord(id: string, type: "observation" | "action" | "audit" | "question", state: string, daysAgo: number) {
  return {
    proposal_id: id,
    proposal_type: type as any,
    pass_id: "p",
    created_at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    state: state as any,
  };
}

describe("computeSignal", () => {
  it("returns null when outcomes is empty", () => {
    expect(computeSignal({}, config)).toBeNull();
  });

  it("returns null when all outcomes are within bootstrap period", () => {
    const outcomes: OutcomeMap = { "obs-1": makeRecord("obs-1", "observation", "pending", 5) };
    expect(computeSignal(outcomes, config)).toBeNull();
  });

  it("returns signal when oldest outcome is beyond bootstrap period", () => {
    const outcomes: OutcomeMap = {
      "obs-1": makeRecord("obs-1", "observation", "accepted", 20),
      "act-1": makeRecord("act-1", "action", "rejected", 20),
    };
    const signal = computeSignal(outcomes, config);
    expect(signal).not.toBeNull();
    expect(signal!.observations.total).toBe(1);
    expect(signal!.observations.acted_on).toBe(1);
    expect(signal!.actions.rejected).toBe(1);
  });

  it("counts acted_on and accepted as acted_on for observations", () => {
    const outcomes: OutcomeMap = {
      "obs-1": makeRecord("obs-1", "observation", "acted_on", 20),
      "obs-2": makeRecord("obs-2", "observation", "accepted", 20),
      "obs-3": makeRecord("obs-3", "observation", "pending", 20),
    };
    const signal = computeSignal(outcomes, config)!;
    expect(signal.observations.acted_on).toBe(2);
    expect(signal.observations.total).toBe(3);
  });

  it("counts reviewed as non-pending non-expired", () => {
    const outcomes: OutcomeMap = {
      "obs-1": makeRecord("obs-1", "observation", "accepted", 20),
      "obs-2": makeRecord("obs-2", "observation", "rejected", 20),
      "obs-3": makeRecord("obs-3", "observation", "expired", 20),
      "obs-4": makeRecord("obs-4", "observation", "pending", 20),
    };
    const signal = computeSignal(outcomes, config)!;
    expect(signal.observations.reviewed).toBe(2);
  });
});

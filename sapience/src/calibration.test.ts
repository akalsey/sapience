import { describe, it, expect } from "vitest";
import {
  getEntry, needsCalibration, upsertEntry,
  applyConfirmation, applyCorrection, addMissingEntries, decayProfile,
} from "./calibration.js";
import type { CalibrationEntry, CalibrationProfile } from "./types.js";

const entry: CalibrationEntry = {
  domain: "github", action_class: "pr_merge",
  tier: "propose", confidence: 0.6,
  confirmed_count: 3, corrected_count: 0,
  last_calibrated: "2026-05-20T00:00:00Z", notes: "",
};

describe("getEntry", () => {
  it("returns matching entry", () => {
    expect(getEntry([entry], "github", "pr_merge")).toEqual(entry);
  });
  it("returns null for unknown domain/class", () => {
    expect(getEntry([entry], "salesforce", "record_update")).toBeNull();
  });
});

describe("needsCalibration", () => {
  it("returns true for null entry", () => {
    expect(needsCalibration(null, 0.4)).toBe(true);
  });
  it("returns true when confidence below threshold", () => {
    expect(needsCalibration({ ...entry, confidence: 0.3 }, 0.4)).toBe(true);
  });
  it("returns false when confidence at or above threshold", () => {
    expect(needsCalibration(entry, 0.4)).toBe(false);
  });
});

describe("upsertEntry", () => {
  it("inserts new entry", () => {
    const profile = upsertEntry([], "github", "pr_merge", { tier: "propose" });
    expect(profile).toHaveLength(1);
    expect(profile[0]!.tier).toBe("propose");
  });
  it("updates existing entry", () => {
    const profile = upsertEntry([entry], "github", "pr_merge", { tier: "act" });
    expect(profile).toHaveLength(1);
    expect(profile[0]!.tier).toBe("act");
  });
  it("does not overwrite other entries", () => {
    const profile = upsertEntry([entry], "salesforce", "record_update", { tier: "explore" });
    expect(profile).toHaveLength(2);
  });
});

describe("applyConfirmation", () => {
  it("increases confidence by 0.1, clamps at 1", () => {
    expect(applyConfirmation({ ...entry, confidence: 0.9 }).confidence).toBeCloseTo(1.0);
    expect(applyConfirmation({ ...entry, confidence: 0.6 }).confidence).toBeCloseTo(0.7);
  });
  it("increments confirmed_count", () => {
    expect(applyConfirmation(entry).confirmed_count).toBe(4);
  });
});

describe("applyCorrection", () => {
  it("decreases confidence by 0.3, floors at 0", () => {
    expect(applyCorrection({ ...entry, confidence: 0.2 }, "explore").confidence).toBeCloseTo(0);
    expect(applyCorrection(entry, "explore").confidence).toBeCloseTo(0.3);
  });
  it("sets new tier and increments corrected_count", () => {
    const result = applyCorrection(entry, "ask");
    expect(result.tier).toBe("ask");
    expect(result.corrected_count).toBe(1);
  });
});

describe("addMissingEntries", () => {
  it("adds only entries whose domain/action_class is absent", () => {
    const current = [
      { domain: "github", action_class: "pr_merge", tier: "propose" as const, confidence: 0.6, confirmed_count: 3, corrected_count: 0, last_calibrated: "2026-01-01T00:00:00Z", notes: "" },
    ];
    const additions = [
      { domain: "github", action_class: "pr_merge", tier: "propose" as const, confidence: 0, confirmed_count: 0, corrected_count: 0, last_calibrated: "2026-06-01T00:00:00Z", notes: "" },
      { domain: "slack", action_class: "send", tier: "propose" as const, confidence: 0, confirmed_count: 0, corrected_count: 0, last_calibrated: "2026-06-01T00:00:00Z", notes: "" },
    ];
    const merged = addMissingEntries(current, additions);
    expect(merged).toHaveLength(2);
    // The existing entry (with learned confidence) wins over the addition.
    expect(merged.find(e => e.domain === "github")!.confidence).toBe(0.6);
    expect(merged.find(e => e.domain === "slack")).toBeDefined();
  });

  it("returns the current profile untouched when nothing is missing", () => {
    const current = [
      { domain: "github", action_class: "pr_merge", tier: "propose" as const, confidence: 0.6, confirmed_count: 3, corrected_count: 0, last_calibrated: "2026-01-01T00:00:00Z", notes: "" },
    ];
    expect(addMissingEntries(current, current)).toEqual(current);
  });
});

describe("decayProfile", () => {
  const NOW = new Date("2026-07-05T00:00:00Z");
  const entry = (confidence: number, daysAgo: number) => ({
    domain: "github", action_class: "pr", tier: "act" as const,
    confidence, confirmed_count: 5, corrected_count: 0,
    last_calibrated: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    notes: "",
  });

  it("leaves recently calibrated confidence intact", () => {
    const [e] = decayProfile([entry(0.8, 5)], NOW);
    expect(e!.confidence).toBeGreaterThan(0.75);
  });

  it("halves confidence after one half-life of silence", () => {
    const [e] = decayProfile([entry(0.8, 90)], NOW);
    expect(e!.confidence).toBeCloseTo(0.4, 1);
  });

  it("is a computed view — the input profile is not mutated", () => {
    const input = [entry(0.8, 90)];
    decayProfile(input, NOW);
    expect(input[0]!.confidence).toBe(0.8);
  });
});

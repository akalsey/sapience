import { describe, it, expect } from "vitest";
import {
  getEntry, needsCalibration, upsertEntry,
  applyConfirmation, applyCorrection,
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

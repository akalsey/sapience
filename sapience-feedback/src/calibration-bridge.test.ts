import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { applyFeedbackToProfile } from "./calibration-bridge.js";
import type { DetectedSignal } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "calibration-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const existingProfile = [
  { domain: "github", action_class: "pr_merge", tier: "propose", confidence: 0.6, confirmed_count: 3, corrected_count: 0, last_calibrated: "2026-05-20T00:00:00Z", notes: "" },
];

describe("applyFeedbackToProfile", () => {
  it("decreases confidence and adjusts tier on correction", async () => {
    const path = join(dir, "calibration.json");
    await writeFile(path, JSON.stringify(existingProfile), "utf-8");
    const signal: DetectedSignal = { type: "correction", domain: "github", action_class: "pr_merge", message: "don't merge without asking", raw_text: "don't merge without asking" };
    await applyFeedbackToProfile(signal, path);
    const updated = JSON.parse(await readFile(path, "utf-8"));
    expect(updated[0].confidence).toBeLessThan(0.6);
    expect(updated[0].corrected_count).toBe(1);
  });

  it("increases confidence on confirmation", async () => {
    const path = join(dir, "calibration.json");
    await writeFile(path, JSON.stringify(existingProfile), "utf-8");
    const signal: DetectedSignal = { type: "confirmation", domain: "github", action_class: "pr_merge", message: "good call", raw_text: "good call" };
    await applyFeedbackToProfile(signal, path);
    const updated = JSON.parse(await readFile(path, "utf-8"));
    expect(updated[0].confidence).toBeGreaterThan(0.6);
  });

  it("adjusts tier on tier_adjustment signal", async () => {
    const path = join(dir, "calibration.json");
    await writeFile(path, JSON.stringify(existingProfile), "utf-8");
    const signal: DetectedSignal = { type: "tier_adjustment", domain: "github", action_class: "pr_merge", message: "just do it", raw_text: "just do it", suggested_tier: "act" };
    await applyFeedbackToProfile(signal, path);
    const updated = JSON.parse(await readFile(path, "utf-8"));
    expect(updated[0].tier).toBe("act");
  });

  it("creates the profile and entry when the file does not exist", async () => {
    const path = join(dir, "nonexistent.json");
    const signal: DetectedSignal = { type: "confirmation", domain: "github", action_class: "pr_merge", message: "good", raw_text: "good" };
    const result = await applyFeedbackToProfile(signal, path);
    expect(result.status).toBe("created");
    const profile = JSON.parse(await readFile(path, "utf-8"));
    expect(profile).toHaveLength(1);
    expect(profile[0].domain).toBe("github");
  });

  it("returns the applied change details", async () => {
    const path = join(dir, "calibration.json");
    await writeFile(path, JSON.stringify(existingProfile), "utf-8");
    const signal: DetectedSignal = { type: "confirmation", domain: "github", action_class: "pr_merge", message: "good call", raw_text: "good call" };
    const result = await applyFeedbackToProfile(signal, path);
    expect(result).toEqual(expect.objectContaining({
      status: "applied",
      old_confidence: 0.6,
      old_tier: "propose",
      new_tier: "propose",
    }));
    expect(result.status).toBe("applied");
    if (result.status === "applied") {
      expect(result.new_confidence).toBeCloseTo(0.7);
    }
  });

  // Feedback about a domain sapience hasn't routed yet used to be dropped as
  // "orphaned" — the correction never affected behavior. Now it seeds a new
  // calibration entry (conservative propose tier, zero confidence) and applies
  // the signal to it, so early feedback isn't lost.
  it("creates a new entry when no entry matches a correction", async () => {
    const path = join(dir, "calibration.json");
    await writeFile(path, JSON.stringify(existingProfile), "utf-8");
    const signal: DetectedSignal = { type: "correction", domain: "unknown", action_class: "x", message: "m", raw_text: "m" };
    const result = await applyFeedbackToProfile(signal, path);
    expect(result).toEqual(expect.objectContaining({ status: "created", old_tier: "propose", old_confidence: 0 }));
    const profile = JSON.parse(await readFile(path, "utf-8"));
    expect(profile).toHaveLength(2);
    const created = profile.find((e: any) => e.domain === "unknown");
    expect(created.corrected_count).toBe(1);
    expect(created.confidence).toBe(0);
    expect(created.tier).toBe("propose");
  });

  it("creates a new entry with the suggested tier on tier_adjustment", async () => {
    const path = join(dir, "calibration.json");
    await writeFile(path, JSON.stringify(existingProfile), "utf-8");
    const signal: DetectedSignal = { type: "tier_adjustment", domain: "slack", action_class: "send", message: "m", raw_text: "m", suggested_tier: "ask" };
    const result = await applyFeedbackToProfile(signal, path);
    expect(result.status).toBe("created");
    const profile = JSON.parse(await readFile(path, "utf-8"));
    expect(profile.find((e: any) => e.domain === "slack").tier).toBe("ask");
  });

  it("does not create an entry for a noop signal", async () => {
    const path = join(dir, "calibration.json");
    await writeFile(path, JSON.stringify(existingProfile), "utf-8");
    const signal: DetectedSignal = { type: "tier_adjustment", domain: "unknown", action_class: "x", message: "m", raw_text: "m" };
    expect(await applyFeedbackToProfile(signal, path)).toEqual({ status: "noop" });
    const profile = JSON.parse(await readFile(path, "utf-8"));
    expect(profile).toHaveLength(1);
  });

  it("returns noop for a tier_adjustment without a suggested tier", async () => {
    const path = join(dir, "calibration.json");
    await writeFile(path, JSON.stringify(existingProfile), "utf-8");
    const signal: DetectedSignal = { type: "tier_adjustment", domain: "github", action_class: "pr_merge", message: "m", raw_text: "m" };
    expect(await applyFeedbackToProfile(signal, path)).toEqual({ status: "noop" });
  });
});

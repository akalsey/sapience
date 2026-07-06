import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { renderProfile, handleProfileCommand } from "./profile-command.js";
import type { CalibrationProfile } from "./types.js";

let dir: string;
let calibrationPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "profile-cmd-"));
  calibrationPath = join(dir, "calibration.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const profile: CalibrationProfile = [
  { domain: "github", action_class: "github/action", tier: "act", confidence: 0.9, confirmed_count: 9, corrected_count: 0, last_calibrated: new Date().toISOString(), notes: "" },
  { domain: "slack", action_class: "slack/action", tier: "propose", confidence: 0.3, confirmed_count: 1, corrected_count: 1, last_calibrated: new Date().toISOString(), notes: "" },
];

describe("renderProfile", () => {
  it("groups entries by tier with confidence percentages", () => {
    const text = renderProfile(profile, new Date());
    expect(text).toContain("Act without asking");
    expect(text).toContain("github/action");
    expect(text).toContain("90%");
    expect(text).toContain("Propose first");
    expect(text).toContain("slack/action");
  });

  it("says so when the profile is empty", () => {
    expect(renderProfile([], new Date())).toContain("No calibration");
  });
});

describe("handleProfileCommand", () => {
  it("shows the profile with no args", async () => {
    await writeFile(calibrationPath, JSON.stringify(profile));
    const out = await handleProfileCommand("", calibrationPath);
    expect(out).toContain("github/action");
  });

  it("sets a tier override with 'set <domain> <action_class> <tier>'", async () => {
    await writeFile(calibrationPath, JSON.stringify(profile));
    const out = await handleProfileCommand("set slack slack/action ask", calibrationPath);
    expect(out.toLowerCase()).toContain("slack/action");
    expect(out).toContain("ask");
    const stored = JSON.parse(await readFile(calibrationPath, "utf-8"));
    expect(stored.find((e: any) => e.domain === "slack").tier).toBe("ask");
  });

  it("rejects invalid tiers and unknown entries", async () => {
    await writeFile(calibrationPath, JSON.stringify(profile));
    expect(await handleProfileCommand("set slack slack/action yolo", calibrationPath)).toContain("Invalid tier");
    expect((await handleProfileCommand("set nope nope/x ask", calibrationPath)).toLowerCase()).toContain("no calibration entry");
  });
});

describe("watches subcommand", () => {
  it("lists watches via /sapience watches", async () => {
    const { addWatch } = await import("./watches.js");
    const watchesPath = join(dir, "watches.json");
    await addWatch(watchesPath, { name: "daily signups", query_hint: "sf", cadence_hours: 24, delta_policy: { kind: "percent", threshold: 20 } });
    const out = await handleProfileCommand("watches", calibrationPath, watchesPath);
    expect(out).toContain("daily signups");
  });
});

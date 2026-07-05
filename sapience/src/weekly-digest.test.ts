// src/weekly-digest.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { digestDue, buildDigestPrompt } from "./weekly-digest.js";
import { DEFAULT_CONFIG } from "./types.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// digestDue replaces the old isDigestDay window check, which fired on every
// routing run in the first half of the digest hour (double delivery on a
// 15-minute cron) and never fired at all for times like "17:45".
describe("digestDue", () => {
  it("is due on the configured day at/after the configured time when not yet sent", () => {
    // 2026-05-23T00:05:00Z = Friday 17:05 PT
    vi.setSystemTime(new Date("2026-05-23T00:05:00Z"));
    const r = digestDue(DEFAULT_CONFIG, null);
    expect(r.due).toBe(true);
    expect(r.localDate).toBe("2026-05-22");
  });

  it("is not due again once sent that local date (no double fire at :00 and :15)", () => {
    vi.setSystemTime(new Date("2026-05-23T00:20:00Z")); // Friday 17:20 PT
    expect(digestDue(DEFAULT_CONFIG, "2026-05-22").due).toBe(false);
  });

  it("is due later in the day when an earlier run was missed", () => {
    vi.setSystemTime(new Date("2026-05-23T04:50:00Z")); // Friday 21:50 PT
    expect(digestDue(DEFAULT_CONFIG, null).due).toBe(true);
  });

  it("honors configured minutes (17:45 fires at 17:45, not 17:15)", () => {
    const cfg = { ...DEFAULT_CONFIG, digest: { ...DEFAULT_CONFIG.digest, time: "17:45" } };
    vi.setSystemTime(new Date("2026-05-23T00:20:00Z")); // Friday 17:20 PT
    expect(digestDue(cfg, null).due).toBe(false);
    vi.setSystemTime(new Date("2026-05-23T00:50:00Z")); // Friday 17:50 PT
    expect(digestDue(cfg, null).due).toBe(true);
  });

  it("is not due on a non-digest day or before the configured time", () => {
    vi.setSystemTime(new Date("2026-05-18T00:05:00Z")); // Monday 17:05 PT
    expect(digestDue(DEFAULT_CONFIG, null).due).toBe(false);
    vi.setSystemTime(new Date("2026-05-22T16:05:00Z")); // Friday 09:05 PT
    expect(digestDue(DEFAULT_CONFIG, null).due).toBe(false);
  });
});

describe("buildDigestPrompt", () => {
  it("returns a string containing weekly summary instructions", async () => {
    const prompt = await buildDigestPrompt({ ...DEFAULT_CONFIG, output: { ...DEFAULT_CONFIG.output, actionLogPath: "/nonexistent/path.md" } });
    expect(prompt).toContain("[SAPIENCE: WEEKLY DIGEST]");
    expect(prompt).toContain("What I did this week");
  });
});

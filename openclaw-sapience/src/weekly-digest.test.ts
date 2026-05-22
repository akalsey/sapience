// src/weekly-digest.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isDigestDay, buildDigestPrompt } from "./weekly-digest.js";
import { DEFAULT_CONFIG } from "./types.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("isDigestDay", () => {
  it("returns true on configured day and time window", () => {
    // 2026-05-23T00:05:00Z = Friday 17:05 PT
    vi.setSystemTime(new Date("2026-05-23T00:05:00Z"));
    expect(isDigestDay(DEFAULT_CONFIG)).toBe(true);
  });

  it("returns false on non-digest day", () => {
    // 2026-05-18T00:05:00Z = Monday 17:05 PT
    vi.setSystemTime(new Date("2026-05-18T00:05:00Z"));
    expect(isDigestDay(DEFAULT_CONFIG)).toBe(false);
  });

  it("returns false outside digest time window", () => {
    // 2026-05-23T16:05:00Z = Friday 09:05 PT
    vi.setSystemTime(new Date("2026-05-23T16:05:00Z"));
    expect(isDigestDay(DEFAULT_CONFIG)).toBe(false);
  });
});

describe("buildDigestPrompt", () => {
  it("returns a string containing weekly summary instructions", async () => {
    const prompt = await buildDigestPrompt({ ...DEFAULT_CONFIG, output: { ...DEFAULT_CONFIG.output, actionLogPath: "/nonexistent/path.md" } });
    expect(prompt).toContain("[SAPIENCE: WEEKLY DIGEST]");
    expect(prompt).toContain("What I did this week");
  });
});

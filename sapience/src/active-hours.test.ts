import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateActiveHours, isWithinActiveHours, type ActiveHours } from "./active-hours.js";

const FALLBACK: ActiveHours = { start: "08:00", end: "20:00", timezone: "America/Los_Angeles" };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("validateActiveHours", () => {
  it("accepts a valid config unchanged", () => {
    const input: ActiveHours = { start: "09:30", end: "18:00", timezone: "Europe/Berlin" };
    expect(validateActiveHours(input, FALLBACK)).toEqual({ hours: input, errors: [] });
  });

  // "8am".split(":").map(Number) is NaN, and every NaN comparison is false —
  // an invalid time silently disabled the plugin on every run, forever.
  it("rejects non-HH:MM times and falls back", () => {
    const { hours, errors } = validateActiveHours({ start: "8am", end: "20:00", timezone: "America/Los_Angeles" }, FALLBACK);
    expect(hours).toEqual(FALLBACK);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("start");
  });

  it("rejects out-of-range times", () => {
    expect(validateActiveHours({ start: "25:00", end: "20:00", timezone: "UTC" }, FALLBACK).errors.length).toBeGreaterThan(0);
    expect(validateActiveHours({ start: "08:00", end: "19:75", timezone: "UTC" }, FALLBACK).errors.length).toBeGreaterThan(0);
  });

  it("rejects an invalid IANA timezone (which used to throw on every run)", () => {
    const { hours, errors } = validateActiveHours({ start: "08:00", end: "20:00", timezone: "Mars/Olympus_Mons" }, FALLBACK);
    expect(hours).toEqual(FALLBACK);
    expect(errors[0]).toContain("timezone");
  });
});

describe("isWithinActiveHours", () => {
  const PT = (h: ActiveHours = { start: "08:00", end: "20:00", timezone: "America/Los_Angeles" }) => h;

  it("is true inside the window and false outside", () => {
    vi.setSystemTime(new Date("2026-05-20T19:00:00Z")); // 12:00 PT
    expect(isWithinActiveHours(PT())).toBe(true);
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z")); // 05:00 PT
    expect(isWithinActiveHours(PT())).toBe(false);
  });

  // start > end used to be an always-false window; it now means "overnight".
  it("supports overnight windows (start > end)", () => {
    const overnight: ActiveHours = { start: "20:00", end: "06:00", timezone: "America/Los_Angeles" };
    vi.setSystemTime(new Date("2026-05-21T05:00:00Z")); // 22:00 PT
    expect(isWithinActiveHours(overnight)).toBe(true);
    vi.setSystemTime(new Date("2026-05-21T19:00:00Z")); // 12:00 PT
    expect(isWithinActiveHours(overnight)).toBe(false);
  });

  it("handles midnight without the h24 '24:xx' quirk", () => {
    const allDay: ActiveHours = { start: "00:00", end: "23:59", timezone: "UTC" };
    vi.setSystemTime(new Date("2026-05-21T00:00:30Z"));
    expect(isWithinActiveHours(allDay)).toBe(true);
  });
});

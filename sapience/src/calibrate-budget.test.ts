import { describe, it, expect } from "vitest";
import { splitByCalibrateBudget, noteCalibrateUse, type DailyCount } from "./calibrate-budget.js";
import type { RoutedItem } from "./types.js";

const item = (id: string, tier: RoutedItem["tier"]): RoutedItem => ({
  id, type: "observation", text: `finding ${id}`,
  domain: "general", action_class: "observation",
  priority: 5, pass_id: `pass-${id}`, pass_timestamp: "2026-08-03T15:00:00Z",
  tier, confidence: 0.1,
});

const fresh: DailyCount = { date: "", count: 0 };

describe("splitByCalibrateBudget", () => {
  // 2026-08-03: 28 deliveries in one day, ALL learning tier, 27 of them at
  // priority 5, and 24 were the agent narrating its own stuck task back to the
  // user who was watching it happen. CALIBRATE exists to sample how much
  // initiative the user wants; a handful a day saturates that signal.
  it("admits up to the day's budget and holds the rest back", () => {
    const items = [1, 2, 3, 4, 5].map((n) => item(`c${n}`, "learning"));
    const { admitted, overBudget } = splitByCalibrateBudget(items, fresh, "2026-08-03", 3);
    expect(admitted.map((i) => i.id)).toEqual(["c1", "c2", "c3"]);
    expect(overBudget.map((i) => i.id)).toEqual(["c4", "c5"]);
  });

  // The budget is a guard on calibration chatter, not on things the user can
  // act on. An outage worth acting on must never be suppressed because the
  // suite spent the day asking questions.
  it("never counts or limits actionable tiers", () => {
    const items = [
      item("a1", "act"), item("p1", "propose"), item("q1", "ask"),
      item("e1", "explore"), ...[1, 2, 3, 4].map((n) => item(`c${n}`, "learning")),
    ];
    const { admitted, overBudget } = splitByCalibrateBudget(items, fresh, "2026-08-03", 2);
    expect(overBudget.map((i) => i.id)).toEqual(["c3", "c4"]);
    expect(admitted.map((i) => i.id)).toEqual(["a1", "p1", "q1", "e1", "c1", "c2"]);
  });

  it("counts what the day already spent", () => {
    const spent: DailyCount = { date: "2026-08-03", count: 2 };
    const items = [1, 2, 3].map((n) => item(`c${n}`, "learning"));
    const { admitted, overBudget } = splitByCalibrateBudget(items, spent, "2026-08-03", 3);
    expect(admitted.map((i) => i.id)).toEqual(["c1"]);
    expect(overBudget).toHaveLength(2);
  });

  it("resets when the local day rolls over", () => {
    const yesterday: DailyCount = { date: "2026-08-02", count: 99 };
    const items = [1, 2].map((n) => item(`c${n}`, "learning"));
    expect(splitByCalibrateBudget(items, yesterday, "2026-08-03", 3).admitted).toHaveLength(2);
  });

  // 0 disables calibrate delivery entirely; a negative or absent cap must not
  // silently mean "none".
  it("treats a non-positive budget as unlimited rather than silencing everything", () => {
    const items = [1, 2, 3].map((n) => item(`c${n}`, "learning"));
    expect(splitByCalibrateBudget(items, fresh, "2026-08-03", -1).overBudget).toHaveLength(0);
    expect(splitByCalibrateBudget(items, fresh, "2026-08-03", 0).overBudget).toHaveLength(3);
  });
});

describe("noteCalibrateUse", () => {
  it("adds to today's count and resets on a new day", () => {
    expect(noteCalibrateUse({ date: "2026-08-03", count: 2 }, "2026-08-03", 1))
      .toEqual({ date: "2026-08-03", count: 3 });
    expect(noteCalibrateUse({ date: "2026-08-02", count: 9 }, "2026-08-03", 2))
      .toEqual({ date: "2026-08-03", count: 2 });
  });
});

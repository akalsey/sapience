import { describe, it, expect } from "vitest";
import { buildDecompositionPrompt, buildWeeklyStatusPrompt } from "./delivery.js";
import type { Goal } from "./types.js";

const activeGoal: Goal = {
  id: "goal-1",
  description: "Improve OKR completion rates across all teams",
  decomposed_approaches: ["send reminders", "build dashboard", "auto-update from data"],
  active_approach: "send reminders",
  status: "active",
  created_at: "2026-05-13T09:00:00Z",
  updated_at: "2026-05-20T09:00:00Z",
  progress_notes: [
    { timestamp: "2026-05-15T10:00:00Z", summary: "Sent first reminder", actions_taken: ["sent slack message"], what_changed: "Team Alpha responded, updated OKRs" },
  ],
  blockers: [{ description: "Team Beta hasn't responded to two reminders", since: "2026-05-17T00:00:00Z", waiting_on: "Team Beta lead" }],
  next_status_delivery: "2026-05-27T09:00:00Z",
};

describe("buildDecompositionPrompt", () => {
  it("contains goal description and GOALS: DECOMPOSE marker", () => {
    const prompt = buildDecompositionPrompt("Improve OKR rates");
    expect(prompt).toContain("[GOALS: DECOMPOSE]");
    expect(prompt).toContain("Improve OKR rates");
  });
});

describe("buildWeeklyStatusPrompt", () => {
  it("contains goal description and progress", () => {
    const prompt = buildWeeklyStatusPrompt(activeGoal);
    expect(prompt).toContain("[GOALS: WEEKLY STATUS]");
    expect(prompt).toContain("Improve OKR completion rates");
    expect(prompt).toContain("Team Alpha responded");
    expect(prompt).toContain("Team Beta");
  });
});

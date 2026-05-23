import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadGoals, saveGoals, addGoal, updateGoalStatus, addProgressNote } from "./goal-store.js";
import type { Goal } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "goals-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const goal: Goal = {
  id: "goal-1", description: "Improve OKR completion rates",
  decomposed_approaches: [], active_approach: "",
  status: "decomposing",
  created_at: "2026-05-20T10:00:00Z", updated_at: "2026-05-20T10:00:00Z",
  progress_notes: [], blockers: [],
  next_status_delivery: "2026-05-27T09:00:00Z",
};

describe("loadGoals", () => {
  it("returns empty array when file does not exist", async () => {
    expect(await loadGoals(join(dir, "goals.json"))).toEqual([]);
  });
});

describe("saveGoals + loadGoals round-trip", () => {
  it("persists and reloads goals", async () => {
    const path = join(dir, "goals.json");
    await saveGoals([goal], path);
    const loaded = await loadGoals(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("goal-1");
  });
});

describe("addGoal", () => {
  it("appends goal to list", () => {
    const updated = addGoal([], goal);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.id).toBe("goal-1");
  });
});

describe("updateGoalStatus", () => {
  it("updates matching goal status", () => {
    const updated = updateGoalStatus([goal], "goal-1", "active");
    expect(updated[0]!.status).toBe("active");
  });
  it("leaves other goals unchanged", () => {
    const other = { ...goal, id: "goal-2" };
    const updated = updateGoalStatus([goal, other], "goal-1", "completed");
    expect(updated[1]!.status).toBe("decomposing");
  });
});

describe("addProgressNote", () => {
  it("appends note to matching goal", () => {
    const note = { timestamp: new Date().toISOString(), summary: "made progress", actions_taken: ["did x"], what_changed: "x is done" };
    const updated = addProgressNote([goal], "goal-1", note);
    expect(updated[0]!.progress_notes).toHaveLength(1);
  });
});

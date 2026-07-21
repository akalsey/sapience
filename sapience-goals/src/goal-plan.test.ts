import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { setGoalPlan, addTodo, completeTodo } from "./goal-store.js";
import { writeGoalSkill, removeGoalSkill } from "./skill-file.js";
import type { Goal } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "goal-plan-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const goal = (): Goal => ({
  id: "goal-1", description: "learn what drives the numbers",
  decomposed_approaches: [], active_approach: "watch metric questions",
  status: "active", created_at: "t", updated_at: "t",
  progress_notes: [], blockers: [], next_status_delivery: "t", todos: [],
});

describe("goal plan store helpers", () => {
  it("setGoalPlan records instructions and seeds todos", () => {
    const out = setGoalPlan([goal()], "goal-1", "When you access PostHog, remember the results.", ["baseline the weekly numbers", "compare week over week"]);
    expect(out[0]!.instructions).toContain("PostHog");
    expect(out[0]!.todos).toHaveLength(2);
    expect(out[0]!.todos[0]!.status).toBe("open");
  });

  it("addTodo appends and completeTodo marks done by id or text", () => {
    let goals = setGoalPlan([goal()], "goal-1", "x", ["first"]);
    goals = addTodo(goals, "goal-1", "second");
    expect(goals[0]!.todos).toHaveLength(2);
    goals = completeTodo(goals, "goal-1", "second");
    const second = goals[0]!.todos.find((t) => t.text === "second")!;
    expect(second.status).toBe("done");
    expect(second.done_at).toBeTruthy();
  });
});

describe("goal skill file", () => {
  it("writes a temporary SKILL.md carrying the standing instructions", async () => {
    const g = { ...goal(), instructions: "When you access Bespin or PostHog, remember the results and compare against what you know." };
    const path = await writeGoalSkill(dir, g);
    const text = await readFile(path, "utf-8");
    expect(text).toContain("name: goal-goal-1");
    expect(text).toContain("Bespin or PostHog");
    expect(text).toContain("temporary");
    expect(text).toContain(g.description);
  });

  it("removeGoalSkill retires the file and tolerates absence", async () => {
    await writeGoalSkill(dir, { ...goal(), instructions: "x" });
    await removeGoalSkill(dir, "goal-1");
    await expect(access(join(dir, "goal-goal-1", "SKILL.md"))).rejects.toThrow();
    await removeGoalSkill(dir, "goal-never-existed");
  });
});

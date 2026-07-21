import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import type { Goal } from "./types.js";

// A goal's standing instructions live as a real workspace skill so they are
// active in every agent session, exactly like a hand-written skill — a goal
// is a temporary skill that builds its own todo list and retires when the
// outcome is reached.

export async function writeGoalSkill(skillsDir: string, goal: Goal): Promise<string> {
  const dir = join(skillsDir, `goal-${goal.id}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  const body = [
    "---",
    `name: goal-${goal.id}`,
    `description: Standing instructions for the goal "${goal.description.replace(/"/g, "'")}" — temporary, managed by sapience-goals; retired when the goal completes.`,
    "---",
    "",
    `# Goal: ${goal.description}`,
    "",
    goal.instructions ?? "",
    "",
    `Progress is tracked as todos on goal ${goal.id} (goal_todo). When new work toward this goal becomes clear, add a todo; when a todo is finished, mark it done.`,
    "",
    "This skill is temporary and managed by sapience-goals. Do not edit by hand; refine the goal's instructions through the goals tools instead.",
  ].join("\n");
  await writeFile(path, body + "\n", "utf-8");
  return path;
}

export async function removeGoalSkill(skillsDir: string, goalId: string): Promise<void> {
  await rm(join(skillsDir, `goal-${goalId}`), { recursive: true, force: true });
}

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { resolvePath } from "./utils.js";
import type { Goal, GoalStatus, ProgressNote } from "./types.js";

export async function loadGoals(path: string): Promise<Goal[]> {
  try {
    return JSON.parse(await readFile(resolvePath(path), "utf-8")) as Goal[];
  } catch { return []; }
}

export async function saveGoals(goals: Goal[], path: string): Promise<void> {
  const resolved = resolvePath(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(goals, null, 2), "utf-8");
}

export function addGoal(goals: Goal[], goal: Goal): Goal[] {
  return [...goals, goal];
}

export function updateGoalStatus(goals: Goal[], id: string, status: GoalStatus): Goal[] {
  return goals.map(g => g.id === id
    ? { ...g, status, updated_at: new Date().toISOString() }
    : g
  );
}

export function addProgressNote(goals: Goal[], id: string, note: ProgressNote): Goal[] {
  return goals.map(g => g.id === id
    ? { ...g, progress_notes: [...g.progress_notes, note], updated_at: new Date().toISOString() }
    : g
  );
}

export function setActiveApproach(goals: Goal[], id: string, approach: string): Goal[] {
  return goals.map(g => g.id === id
    ? { ...g, active_approach: approach, status: "active", updated_at: new Date().toISOString() }
    : g
  );
}

export function addBlocker(goals: Goal[], id: string, blocker: { description: string; waiting_on: string }): Goal[] {
  return goals.map(g => g.id === id
    ? { ...g, blockers: [...g.blockers, { ...blocker, since: new Date().toISOString() }], updated_at: new Date().toISOString() }
    : g
  );
}

export function updateNextDelivery(goals: Goal[], id: string, nextDelivery: string): Goal[] {
  return goals.map(g => g.id === id ? { ...g, next_status_delivery: nextDelivery } : g);
}

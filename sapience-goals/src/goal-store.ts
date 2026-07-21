import { resolvePath } from "./utils.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";
import type { Goal, GoalMetric, GoalStatus, ProgressNote, GoalTodo } from "./types.js";

export async function loadGoals(path: string): Promise<Goal[]> {
  return readJsonSafe<Goal[]>(resolvePath(path), []);
}

export async function saveGoals(goals: Goal[], path: string): Promise<void> {
  await writeJsonAtomic(resolvePath(path), goals);
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

export function setGoalMetric(goals: Goal[], id: string, metric: GoalMetric): Goal[] {
  return goals.map(g => g.id === id
    ? { ...g, metric, updated_at: new Date().toISOString() }
    : g
  );
}

export function updateNextDelivery(goals: Goal[], id: string, nextDelivery: string): Goal[] {
  return goals.map(g => g.id === id ? { ...g, next_status_delivery: nextDelivery } : g);
}

function makeTodo(text: string): GoalTodo {
  return {
    id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    status: "open",
    added_at: new Date().toISOString(),
  };
}

function mutate(goals: Goal[], id: string, fn: (g: Goal) => Goal): Goal[] {
  return goals.map((g) => (g.id === id ? { ...fn({ ...g, todos: g.todos ?? [] }), updated_at: new Date().toISOString() } : g));
}

export function setGoalPlan(goals: Goal[], id: string, instructions: string, todos: string[]): Goal[] {
  return mutate(goals, id, (g) => ({ ...g, instructions, todos: [...g.todos, ...todos.map(makeTodo)] }));
}

export function addTodo(goals: Goal[], id: string, text: string): Goal[] {
  return mutate(goals, id, (g) => ({ ...g, todos: [...g.todos, makeTodo(text)] }));
}

// Accepts a todo id or its exact text — the agent usually has the text.
export function completeTodo(goals: Goal[], id: string, todoIdOrText: string): Goal[] {
  return mutate(goals, id, (g) => ({
    ...g,
    todos: g.todos.map((t) =>
      (t.id === todoIdOrText || t.text === todoIdOrText) && t.status === "open"
        ? { ...t, status: "done" as const, done_at: new Date().toISOString() }
        : t
    ),
  }));
}

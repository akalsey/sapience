export type GoalStatus = "decomposing" | "active" | "paused" | "completed" | "abandoned";

export interface ProgressNote {
  timestamp: string;
  summary: string;
  actions_taken: string[];
  what_changed: string;
}

export interface Blocker {
  description: string;
  since: string;
  waiting_on: string;
}

export interface Goal {
  id: string;
  description: string;
  decomposed_approaches: string[];
  active_approach: string;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
  progress_notes: ProgressNote[];
  blockers: Blocker[];
  next_status_delivery: string;
}

export interface GoalsConfig {
  schedule: string;
  activeHours: { start: string; end: string; timezone: string };
  weeklyCheckInDay: string;
  weeklyCheckInTime: string;
  inboxPath: string;
  inboxPositionPath: string;
  output: { goalsPath: string };
}

export const DEFAULT_CONFIG: GoalsConfig = {
  schedule: "*/15 * * * *",
  activeHours: { start: "08:00", end: "20:00", timezone: "America/Los_Angeles" },
  weeklyCheckInDay: "monday",
  weeklyCheckInTime: "09:00",
  inboxPath: "goals/inbox.md",
  inboxPositionPath: "goals/inbox-position.json",
  output: { goalsPath: "goals/goals.json" },
};

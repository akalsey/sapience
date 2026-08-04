export type Tier = "act" | "propose" | "ask" | "explore" | "learning";

export interface CalibrationEntry {
  domain: string;
  action_class: string;
  tier: "act" | "propose" | "ask" | "explore";
  confidence: number;        // 0.0–1.0
  confirmed_count: number;
  corrected_count: number;
  last_calibrated: string;   // ISO-8601
  notes: string;
}

export type CalibrationProfile = CalibrationEntry[];

// A single routable item derived from a ProposalSet field
export interface SapienceItem {
  id: string;
  type: "observation" | "action" | "audit" | "question";
  text: string;
  domain: string;
  action_class: string;
  priority: number;
  pass_id: string;
  pass_timestamp: string;
  evidence_grade?: "hunch" | "quick_check" | "replicated";
  reversible?: boolean;
}

export interface RoutedItem extends SapienceItem {
  tier: Tier;
  confidence: number;
}

export interface SapienceConfig {
  schedule: string;
  activeHours: { start: string; end: string; timezone: string };
  proactiveThinking: { proposalsPath: string };
  learning: {
    enabled: boolean;
    recalibrateOnNewDomain: boolean;
    confidenceDropThreshold: number;
  };
  autonomy: {
    defaultTier: "act" | "propose" | "ask" | "explore";
    domainFloors: Record<string, "propose" | "ask" | "explore">;
  };
  digest: { enabled: boolean; day: string; time: string };
  // Per routing run, at most this many items ship in the single injected
  // note; the rest queue for the delivery cron, which composes them into one
  // message. Default 1 — a turn carrying eight initiative questions ahead of
  // the user's own message is nobody's idea of a calibration conversation.
  // dedupeWindowHours: an item whose text matches something already delivered
  // within this window is suppressed instead of re-delivered.
  // maxCalibratePerDay: ceiling on CALIBRATE notes per local day. Negative
  // means unlimited; 0 turns them off. Actionable tiers are never capped.
  delivery: { maxPerCycle: number; dedupeWindowHours: number; maxCalibratePerDay: number };
  // Proactive channel push for initiative-worthy items (act/propose at or
  // above minPriority), budgeted per local day.
  push: { enabled: boolean; maxPerDay: number; minPriority: number };
  // Bounded read-only follow-up on hunch-graded items, budgeted per local day.
  investigation: { enabled: boolean; maxPerDay: number; minPriority: number; timeoutSec: number };
  // Autonomous execution of act-tier items in isolated subagent sessions.
  act: { execute: boolean; timeoutSec: number };
  // Metric watches checked during routing passes.
  watch: { maxChecksPerRun: number; timeoutSec: number };
  // Extra roots to scan for already-installed skills, on top of
  // `<workspace>/skills` and the state dir's `skills/`. Only needed when an
  // install keeps skills somewhere unconventional — the skill_proposal guard
  // can only refuse duplicates of skills it can see.
  skillsDirs: string[];
  output: {
    calibrationPath: string;
    actionLogPath: string;
    processedPassesPath: string;
    eventsPath: string;
    dashboardPath: string;
    goalsPath: string;
    pushStatePath: string;
    calibrateStatePath: string;
    investigationStatePath: string;
    hypothesesPath: string;
    watchesPath: string;
    pendingDeliveriesPath: string;
    deliveredLedgerPath: string;
    skillProposalsPath: string;
    // The human-readable spec doc lives at the workspace root where the
    // operator already reads it, not under sapience/.
    skillProposalsDocPath: string;
  };
}

export const DEFAULT_CONFIG: SapienceConfig = {
  schedule: "*/15 * * * *",
  activeHours: { start: "08:00", end: "20:00", timezone: "America/Los_Angeles" },
  proactiveThinking: {
    proposalsPath: "proactive-thinking/proposals.jsonl",
  },
  learning: {
    enabled: true,
    recalibrateOnNewDomain: true,
    confidenceDropThreshold: 0.4,
  },
  autonomy: {
    defaultTier: "propose",
    domainFloors: {},
  },
  digest: { enabled: true, day: "friday", time: "17:00" },
  delivery: { maxPerCycle: 1, dedupeWindowHours: 72, maxCalibratePerDay: 3 },
  push: { enabled: true, maxPerDay: 6, minPriority: 4 },
  investigation: { enabled: true, maxPerDay: 3, minPriority: 3, timeoutSec: 120 },
  act: { execute: true, timeoutSec: 300 },
  watch: { maxChecksPerRun: 2, timeoutSec: 120 },
  skillsDirs: [],
  output: {
    calibrationPath: "sapience/calibration.json",
    actionLogPath: "sapience/action-log.md",
    processedPassesPath: "sapience/processed-passes.json",
    eventsPath: "sapience/events.jsonl",
    dashboardPath: "sapience/dashboard.md",
    goalsPath: "goals/goals.json",
    pushStatePath: "sapience/push-state.json",
    calibrateStatePath: "sapience/calibrate-state.json",
    investigationStatePath: "sapience/investigation-state.json",
    hypothesesPath: "sapience/hypotheses.json",
    watchesPath: "sapience/watches.json",
    pendingDeliveriesPath: "sapience/pending-deliveries.json",
    deliveredLedgerPath: "sapience/delivered-ledger.json",
    skillProposalsPath: "sapience/skill-proposals.json",
    skillProposalsDocPath: "skill-proposals.md",
  },
};

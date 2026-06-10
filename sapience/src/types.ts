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
  output: {
    calibrationPath: string;
    actionLogPath: string;
    processedPassesPath: string;
    eventsPath: string;
    dashboardPath: string;
    goalsPath: string;
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
  output: {
    calibrationPath: "sapience/calibration.json",
    actionLogPath: "sapience/action-log.md",
    processedPassesPath: "sapience/processed-passes.json",
    eventsPath: "sapience/events.jsonl",
    dashboardPath: "sapience/dashboard.md",
    goalsPath: "goals/goals.json",
  },
};

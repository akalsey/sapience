export type FeedbackSignalType = "correction" | "confirmation" | "tier_adjustment";

export interface DetectedSignal {
  type: FeedbackSignalType;
  domain: string;
  action_class: string;
  message: string;
  suggested_tier?: "act" | "propose" | "ask" | "explore";
  raw_text: string;
}

export interface FeedbackEntry {
  id: string;
  detected_at: string;
  signal: DetectedSignal;
  meta_pointer?: string;
}

export interface FeedbackConfig {
  logPath: string;
  calibrationPath: string;
  memoryEnabled: boolean;
}

export const DEFAULT_CONFIG: FeedbackConfig = {
  logPath: "sapience/feedback.md",
  calibrationPath: "sapience/calibration.json",
  memoryEnabled: true,
};

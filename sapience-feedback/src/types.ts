export type FeedbackSignalType = "correction" | "confirmation" | "tier_adjustment";

export interface DetectedSignal {
  type: FeedbackSignalType;
  domain: string;
  action_class: string;
  message: string;
  suggested_tier?: "act" | "propose" | "ask" | "explore";
  raw_text: string;
  confidence?: number;
  source?: "regex" | "llm" | "manual";
}

export interface FeedbackEntry {
  id: string;
  detected_at: string;
  signal: DetectedSignal;
  meta_pointer?: string;
}

export interface SemanticDetectionConfig {
  enabled: boolean;
  minLength: number;
  minConfidence: number;
}

export interface FeedbackConfig {
  logPath: string;
  calibrationPath: string;
  eventsPath: string;
  memoryEnabled: boolean;
  semanticDetection: SemanticDetectionConfig;
}

export const DEFAULT_CONFIG: FeedbackConfig = {
  logPath: "sapience/feedback.md",
  calibrationPath: "sapience/calibration.json",
  eventsPath: "sapience/events.jsonl",
  memoryEnabled: true,
  semanticDetection: {
    enabled: true,
    minLength: 8,
    minConfidence: 0.6,
  },
};

export interface LlmCompleteMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteParams {
  messages: LlmCompleteMessage[];
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  purpose?: string;
}

export interface LlmCompleteResult {
  text: string;
}

export interface LlmClient {
  complete(params: LlmCompleteParams): Promise<LlmCompleteResult>;
}

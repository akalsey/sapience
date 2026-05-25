import type { DetectedSignal, FeedbackConfig, FeedbackEntry, LlmClient } from "./types.js";
import { parseMessage } from "./feedback-parser.js";
import { classifyWithLlm } from "./llm-classifier.js";
import { appendFeedback } from "./log-writer.js";
import { applyFeedbackToProfile } from "./calibration-bridge.js";
import { generateId } from "./utils.js";

export function shouldClassify(text: string, config: FeedbackConfig): boolean {
  const trimmed = text.trim();
  if (trimmed.length < config.semanticDetection.minLength) return false;
  if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) return false;
  return true;
}

export async function classifyMessage(
  text: string,
  config: FeedbackConfig,
  llm: LlmClient | null
): Promise<DetectedSignal[]> {
  if (!shouldClassify(text, config)) return [];

  if (config.semanticDetection.enabled && llm) {
    const signals = await classifyWithLlm(text, llm, {
      minConfidence: config.semanticDetection.minConfidence,
    });
    if (signals.length > 0) return signals;
  }

  return parseMessage(text).map(s => ({ ...s, source: "regex" as const }));
}

export function buildMetaPointer(signal: DetectedSignal): string {
  return `Before working on ${signal.domain} / ${signal.action_class}: check feedback log — correction recorded: "${signal.raw_text.slice(0, 80)}"`;
}

export interface PersistContext {
  config: FeedbackConfig;
  memoryAdd?: (params: { content: string; metadata: Record<string, unknown> }) => Promise<unknown> | unknown;
}

export async function persistSignal(signal: DetectedSignal, ctx: PersistContext): Promise<FeedbackEntry> {
  const metaPointer = signal.type === "correction" ? buildMetaPointer(signal) : undefined;

  const entry: FeedbackEntry = {
    id: generateId(),
    detected_at: new Date().toISOString(),
    signal,
    meta_pointer: metaPointer,
  };

  await appendFeedback(entry, ctx.config.logPath);
  await applyFeedbackToProfile(signal, ctx.config.calibrationPath);

  if (metaPointer && ctx.config.memoryEnabled && ctx.memoryAdd) {
    await ctx.memoryAdd({
      content: metaPointer,
      metadata: { tags: ["feedback", "behavioral-correction", signal.domain], source: "feedback" },
    });
  }

  return entry;
}

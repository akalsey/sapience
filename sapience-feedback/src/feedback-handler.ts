import type { DetectedSignal, FeedbackConfig, FeedbackEntry, LlmClient } from "./types.js";
import { parseMessage } from "./feedback-parser.js";
import { classifyWithLlm } from "./llm-classifier.js";
import { appendFeedback } from "./log-writer.js";
import { applyFeedbackToProfile } from "./calibration-bridge.js";
import { appendEvent } from "./events.js";
import { generateId } from "./utils.js";
import { rotateKeepingTail } from "./rotate.js";
import { addPlaybook } from "./playbooks.js";

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
  await rotateKeepingTail(ctx.config.logPath).catch(() => {});

  // Method feedback teaches HOW to analyze, not how much autonomy to take —
  // it amends the shared playbook library instead of moving confidence.
  if (signal.type === "method") {
    const playbook = await addPlaybook(ctx.config.playbooksPath, signal.raw_text);
    await appendEvent(ctx.config.eventsPath, {
      plugin: "feedback",
      type: playbook ? "playbook_added" : "playbook_duplicate",
      domain: signal.domain,
      source: signal.source ?? "regex",
    });
    return entry;
  }

  const result = await applyFeedbackToProfile(signal, ctx.config.calibrationPath);

  if (metaPointer && ctx.config.memoryEnabled && ctx.memoryAdd) {
    // The memory slot is optional infrastructure: a failure there must not
    // void the log append and calibration change that already succeeded.
    try {
      await ctx.memoryAdd({
        content: metaPointer,
        metadata: { tags: ["feedback", "behavioral-correction", signal.domain], source: "feedback" },
      });
    } catch (err) {
      await appendEvent(ctx.config.eventsPath, {
        plugin: "feedback",
        type: "memory_write_failed",
        domain: signal.domain,
        reason: String(err),
      });
    }
  }

  await appendEvent(ctx.config.eventsPath, {
    plugin: "feedback",
    type: "signal_detected",
    signal_type: signal.type,
    domain: signal.domain,
    action_class: signal.action_class,
    source: signal.source ?? "regex",
  });
  if (result.status === "applied" || result.status === "created") {
    await appendEvent(ctx.config.eventsPath, {
      plugin: "feedback",
      type: "calibration_change",
      domain: signal.domain,
      action_class: signal.action_class,
      old_confidence: result.old_confidence,
      new_confidence: result.new_confidence,
      old_tier: result.old_tier,
      new_tier: result.new_tier,
      source: result.status === "created" ? "feedback_new_entry" : "feedback",
    });
  }

  return entry;
}

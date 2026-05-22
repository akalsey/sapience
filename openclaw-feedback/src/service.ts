// src/service.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, type FeedbackConfig, type FeedbackEntry } from "./types.js";
import { resolvePath, generateId } from "./utils.js";
import { parseMessage } from "./feedback-parser.js";
import { appendFeedback } from "./log-writer.js";
import { applyFeedbackToProfile } from "./calibration-bridge.js";

function mergeConfig(raw: Record<string, unknown>): FeedbackConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<FeedbackConfig>),
    logPath: resolvePath(((raw as any).logPath ?? DEFAULT_CONFIG.logPath) as string),
    calibrationPath: resolvePath(((raw as any).calibrationPath ?? DEFAULT_CONFIG.calibrationPath) as string),
  };
}

function buildMetaPointer(signal: { domain: string; action_class: string; raw_text: string }): string {
  return `Before working on ${signal.domain} / ${signal.action_class}: check feedback log — correction recorded: "${signal.raw_text.slice(0, 80)}"`;
}

export default definePluginEntry({
  id: "feedback",
  name: "Feedback",
  description: "Persists behavioral corrections and confirmations into the sapience calibration profile",

  register(api: any) {
    const config = mergeConfig(api.pluginConfig as Record<string, unknown>);

    if (api.session?.onMessage) {
      api.session.onMessage(async (message: { role: string; content: string }) => {
        if (message.role !== "user") return;

        const signals = parseMessage(message.content);
        for (const signal of signals) {
          const metaPointer = signal.type === "correction" ? buildMetaPointer(signal) : undefined;

          const entry: FeedbackEntry = {
            id: generateId(),
            detected_at: new Date().toISOString(),
            signal,
            meta_pointer: metaPointer,
          };

          await appendFeedback(entry, config.logPath);
          await applyFeedbackToProfile(signal, config.calibrationPath);

          if (metaPointer && config.memoryEnabled && api.memory?.write) {
            await api.memory.write({ text: metaPointer, type: "behavioral-correction" });
          }
        }
      });
    }
  },
});

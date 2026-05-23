// src/service.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, type FeedbackConfig, type FeedbackEntry } from "./types.js";
import { resolveDataPath, generateId } from "./utils.js";
import { parseMessage } from "./feedback-parser.js";
import { appendFeedback } from "./log-writer.js";
import { applyFeedbackToProfile } from "./calibration-bridge.js";

function mergeConfig(raw: Record<string, unknown>, workspaceDir: string): FeedbackConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<FeedbackConfig>),
    logPath: resolveDataPath((raw as any).logPath, workspaceDir, DEFAULT_CONFIG.logPath),
    calibrationPath: resolveDataPath((raw as any).calibrationPath, workspaceDir, DEFAULT_CONFIG.calibrationPath),
  };
}

function buildMetaPointer(signal: { domain: string; action_class: string; raw_text: string }): string {
  return `Before working on ${signal.domain} / ${signal.action_class}: check feedback log — correction recorded: "${signal.raw_text.slice(0, 80)}"`;
}

export default definePluginEntry({
  id: "sapience-feedback",
  name: "Sapience Feedback",
  description: "Persists behavioral corrections and confirmations into the sapience calibration profile",

  register(api: any) {
    const workspaceDir = (api.runtime.agent.resolveAgentWorkspaceDir as (cfg: unknown) => string)(api.pluginConfig);
    const config = mergeConfig(api.pluginConfig as Record<string, unknown>, workspaceDir);

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

          if (metaPointer && config.memoryEnabled) {
            await api.memory?.add({
              content: metaPointer,
              metadata: { tags: ["feedback", "behavioral-correction", signal.domain], source: "feedback" },
            });
          }
        }
      });
    }
  },
});

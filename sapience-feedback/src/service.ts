// src/service.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, type FeedbackConfig, type LlmClient } from "./types.js";
import { resolveDataPath } from "./utils.js";
import { classifyMessage, persistSignal } from "./feedback-handler.js";

function mergeConfig(raw: Record<string, unknown>, workspaceDir: string): FeedbackConfig {
  const rawSemantic = (raw as Partial<FeedbackConfig>).semanticDetection ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<FeedbackConfig>),
    logPath: resolveDataPath((raw as any).logPath, workspaceDir, DEFAULT_CONFIG.logPath),
    calibrationPath: resolveDataPath((raw as any).calibrationPath, workspaceDir, DEFAULT_CONFIG.calibrationPath),
    eventsPath: resolveDataPath((raw as any).eventsPath, workspaceDir, DEFAULT_CONFIG.eventsPath),
    semanticDetection: { ...DEFAULT_CONFIG.semanticDetection, ...rawSemantic },
  };
}

function getLlmClient(api: any): LlmClient | null {
  const llm = api?.runtime?.llm;
  if (!llm || typeof llm.complete !== "function") return null;
  return { complete: (params) => llm.complete(params) };
}

export default definePluginEntry({
  id: "sapience-feedback",
  name: "Sapience Feedback",
  description: "Persists behavioral corrections and confirmations into the sapience calibration profile",

  register(api: any) {
    const workspaceDir = (api.runtime.agent.resolveAgentWorkspaceDir as (cfg: unknown) => string)(api.pluginConfig);
    const config = mergeConfig(api.pluginConfig as Record<string, unknown>, workspaceDir);
    const llm = getLlmClient(api);
    const memoryAdd = api.memory?.add ? (params: any) => api.memory.add(params) : undefined;

    if (api.session?.onMessage) {
      api.session.onMessage(async (message: { role: string; content: string }) => {
        if (message.role !== "user") return;
        try {
          const signals = await classifyMessage(message.content, config, llm);
          for (const signal of signals) {
            await persistSignal(signal, { config, memoryAdd });
          }
        } catch {
          // don't let feedback processing errors disrupt the session
        }
      });
    }

    if (typeof api.registerCommand === "function") {
      api.registerCommand({
        name: "feedback",
        description: "Record explicit feedback for the agent to learn from. Usage: /feedback <your feedback>",
        acceptsArgs: true,
        handler: async (ctx: { args?: string }) => {
          const text = (ctx.args ?? "").trim();
          if (!text) {
            return { text: "Usage: /feedback <your feedback>\n\nExample: /feedback always check the password manager before asking me for credentials" };
          }

          try {
            let signals = await classifyMessage(text, config, llm);
            if (signals.length === 0) {
              signals = [{
                type: "correction",
                domain: "general",
                action_class: "general",
                message: text,
                raw_text: text,
                source: "manual",
              }];
            } else {
              signals = signals.map(s => ({ ...s, source: "manual" as const }));
            }

            for (const signal of signals) {
              await persistSignal(signal, { config, memoryAdd });
            }

            const summary = signals.map(s =>
              s.type === "tier_adjustment" && s.suggested_tier
                ? `${s.type} → ${s.suggested_tier} (${s.domain})`
                : `${s.type} (${s.domain})`
            ).join(", ");
            return { text: `Recorded ${signals.length} feedback signal(s): ${summary}` };
          } catch (err) {
            return { text: `Failed to record feedback: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });
    }
  },
});

// src/service.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readRuntime } from "./safe-runtime.js";
import { resolveAgentId } from "./resolve-agent.js";
import { DEFAULT_CONFIG, type FeedbackConfig, type LlmClient } from "./types.js";
import { resolveDataPath } from "./utils.js";
import { classifyMessage, persistSignal } from "./feedback-handler.js";
import { compileExtraDomains } from "./domains.js";
import { writeStatusArtifact, resolvePluginVersion } from "./status-artifact.js";

function mergeConfig(raw: Record<string, unknown>, workspaceDir: string): FeedbackConfig {
  const rawSemantic = (raw as Partial<FeedbackConfig>).semanticDetection ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<FeedbackConfig>),
    logPath: resolveDataPath((raw as any).logPath, workspaceDir, DEFAULT_CONFIG.logPath),
    calibrationPath: resolveDataPath((raw as any).calibrationPath, workspaceDir, DEFAULT_CONFIG.calibrationPath),
    playbooksPath: resolveDataPath((raw as any).playbooksPath, workspaceDir, DEFAULT_CONFIG.playbooksPath),
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
    // Reading api.runtime THROWS during "cli-metadata" registration, where the
    // host walks plugins only to learn their root CLI commands. readRuntime
    // contains that, and — critically — the failure path below never touches
    // api.runtime again. The previous version asked `if (api?.runtime?.agent)`
    // here to tell a real fault from the expected CLI bail; that second read
    // threw straight out of register(), so the gateway failed the whole plugin
    // and took `openclaw sapience doctor` down with it.
    const resolved = readRuntime<string>(api, (runtime) =>
      (runtime.agent.resolveAgentWorkspaceDir as (cfg: unknown) => string)(api.pluginConfig));
    if (resolved.value === undefined) {
      // `available` separates the two cases without a second read: a runtime
      // that existed but failed to resolve a workspace is the silent death that
      // once left a plugin "vunknown" for nine days, so record it. An absent or
      // unavailable runtime is the CLI bail — stay quiet.
      if (resolved.available) {
        void writeStatusArtifact({
          pluginId: "sapience-feedback",
          version: resolvePluginVersion(),
          agentId: "unknown",
          resolvedWorkspaceDir: "",
          outputPaths: {},
          initError: String(resolved.error),
          initAt: new Date().toISOString(),
        }).catch(() => {});
      }
      return;
    }
    const workspaceDir: string = resolved.value;
    const config = mergeConfig(api.pluginConfig as Record<string, unknown>, workspaceDir);
    const llm = getLlmClient(api);
    const extraDomains = compileExtraDomains((api.pluginConfig as Record<string, unknown>)?.domains);
    const memoryAdd = api.memory?.add ? (params: any) => api.memory.add(params) : undefined;

    // Passive capture rides the gateway's internal message hooks — the only
    // per-message surface the plugin API exposes. (An earlier version guarded
    // on api.session.onMessage, which does not exist, so capture silently
    // never registered.)
    const hookCapture = typeof api.registerHook === "function";
    if (hookCapture) {
      // The gateway requires a unique opts.name (typed optional, enforced at
      // runtime) — registering without one throws and kills the whole plugin.
      api.registerHook("message", async (event: { action?: string; context?: Record<string, unknown> }) => {
        if (event?.action !== "received") return;
        const content = event?.context?.content;
        if (typeof content !== "string" || !content.trim()) return;
        try {
          const signals = await classifyMessage(content, config, llm, extraDomains);
          for (const signal of signals) {
            await persistSignal(signal, { config, memoryAdd });
          }
        } catch {
          // don't let feedback processing errors disrupt message handling
        }
      }, { name: "sapience-feedback-capture", description: "Passive feedback capture from received messages" });
    }

    // Record what this plugin actually resolved, for `openclaw sapience doctor`.
    // captureMode makes a degraded install (no hook surface → /feedback only)
    // visible instead of silent.
    void writeStatusArtifact({
      pluginId: "sapience-feedback",
      version: resolvePluginVersion(),
      agentId: resolveAgentId(api.config),
      resolvedWorkspaceDir: workspaceDir,
      outputPaths: { logPath: config.logPath, calibrationPath: config.calibrationPath, eventsPath: config.eventsPath },
      captureMode: hookCapture ? "message-hook" : "command-only",
      initAt: new Date().toISOString(),
    }).catch(() => {});

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
            let signals = await classifyMessage(text, config, llm, extraDomains);
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

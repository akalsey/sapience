import { join } from "path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";

import { buildContext, getLastThreePasses } from "./context-builder.js";
import { buildPrompt } from "./prompt-builder.js";
import { parseProposals, ParseError } from "./output-parser.js";
import { appendPass, appendError, appendSkipped, appendStructuredProposals } from "./log-writer.js";
import { appendEvent } from "./events.js";
import { loadOutcomes, saveOutcomes, addProposals, expireOldProposals } from "./outcome-tracker.js";
import { computeSignal } from "./signal-analyzer.js";
import { maybeDeliver } from "./delivery.js";
import { DEFAULT_CONFIG, type PluginConfig } from "./types.js";
import { resolveDataPath } from "./utils.js";
import { writeStatusArtifact, resolvePluginVersion } from "./status-artifact.js";
import { acquireLock, releaseLock, clearLock } from "./lock.js";
import { isSapienceActive } from "./presence.js";

function isWithinActiveHours(config: PluginConfig): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: config.activeHours.timezone,
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const [hours, minutes] = formatter.format(new Date()).split(":").map(Number);
  const now = (hours ?? 0) * 60 + (minutes ?? 0);
  const [sh, sm] = config.activeHours.start.split(":").map(Number);
  const [eh, em] = config.activeHours.end.split(":").map(Number);
  return now >= (sh ?? 0) * 60 + (sm ?? 0) && now <= (eh ?? 0) * 60 + (em ?? 0);
}

function mergeConfig(raw: Record<string, unknown>, workspaceDir: string): PluginConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<PluginConfig>),
    activeHours: { ...DEFAULT_CONFIG.activeHours, ...((raw.activeHours as object) ?? {}) },
    context: { ...DEFAULT_CONFIG.context, ...((raw.context as object) ?? {}) },
    output: {
      ...DEFAULT_CONFIG.output,
      ...((raw.output as object) ?? {}),
      logPath: resolveDataPath((raw as any).output?.logPath, workspaceDir, DEFAULT_CONFIG.output.logPath),
      proposalsPath: resolveDataPath((raw as any).output?.proposalsPath, workspaceDir, DEFAULT_CONFIG.output.proposalsPath),
      trackerPath: resolveDataPath((raw as any).output?.trackerPath, workspaceDir, DEFAULT_CONFIG.output.trackerPath),
      eventsPath: resolveDataPath((raw as any).output?.eventsPath, workspaceDir, DEFAULT_CONFIG.output.eventsPath),
    },
    delivery: { ...DEFAULT_CONFIG.delivery, ...((raw.delivery as object) ?? {}) },
    learning: { ...DEFAULT_CONFIG.learning, ...((raw.learning as object) ?? {}) },
  };
}

export default definePluginEntry({
  id: "sapience-thinking",
  name: "Sapience Thinking",
  description: "Periodic isolated thinking passes that produce structured proposals",

  register(api: any) {
    let workspaceDir: string;
    try {
      workspaceDir = (api.runtime.agent.resolveAgentWorkspaceDir as (cfg: unknown) => string)(api.pluginConfig);
    } catch { return; }
    const config = mergeConfig(api.pluginConfig as Record<string, unknown>, workspaceDir);
    const lockFile = join(workspaceDir, "proactive-thinking", ".pass.lock");
    const agentId: string = ((api.config as Record<string, unknown>)?.agent as Record<string, unknown>)?.id as string ?? "default";

    // A gateway restart means no pass can be running; drop any leftover lock.
    void clearLock(lockFile).catch(() => {});

    // Record what this plugin actually resolved, for `openclaw sapience doctor`.
    void writeStatusArtifact({
      pluginId: "sapience-thinking",
      version: resolvePluginVersion(),
      agentId,
      resolvedWorkspaceDir: workspaceDir,
      outputPaths: config.output as unknown as Record<string, string>,
      initAt: new Date().toISOString(),
    }).catch(() => {});

    api.registerTool({
      name: "get_thinking_context",
      description: "Fetch context bundle and thinking instructions. Call this first in every thinking pass.",
      parameters: Type.Object({}),
      async execute(_id: any, _params: any) {
        if (!isWithinActiveHours(config)) {
          await appendEvent(config.output.eventsPath, { plugin: "thinking", type: "pass_skipped", reason: "outside_hours" });
          return { content: [{ type: "text", text: JSON.stringify({ status: "skip", reason: "outside_active_hours" }) }] };
        }
        const acquired = await acquireLock(lockFile);
        if (!acquired) {
          await appendSkipped("pass_already_running", config.output.logPath);
          await appendEvent(config.output.eventsPath, { plugin: "thinking", type: "pass_skipped", reason: "already_running" });
          return { content: [{ type: "text", text: JSON.stringify({ status: "skip", reason: "pass_already_running" }) }] };
        }
        try {
          const [bundle, recentPasses, outcomes] = await Promise.all([
            buildContext(config, agentId),
            getLastThreePasses(config.output.logPath),
            loadOutcomes(config.output.trackerPath),
          ]);
          bundle.recentPasses = recentPasses;
          const signal = config.learning.adjustPromptBasedOnSignal ? computeSignal(outcomes, config) : null;
          const prompt = await buildPrompt(bundle, signal);
          return { content: [{ type: "text", text: prompt }] };
        } catch (err) {
          await releaseLock(lockFile);
          throw err;
        }
      },
    });

    api.registerTool({
      name: "record_thinking_output",
      description: "Record structured thinking proposals from this pass. Call after get_thinking_context.",
      parameters: Type.Object({ proposals: Type.Unknown() }),
      async execute(_id: any, params: any) {
        try {
          const proposals = parseProposals(params.proposals);
          await appendPass(proposals, config.output.logPath);
          await appendStructuredProposals(proposals, config.output.proposalsPath);
          if (config.learning.trackOutcomes) {
            let outcomes = await loadOutcomes(config.output.trackerPath);
            outcomes = addProposals(outcomes, proposals);
            outcomes = expireOldProposals(outcomes);
            await saveOutcomes(outcomes, config.output.trackerPath);
          }
          await appendEvent(config.output.eventsPath, {
            plugin: "thinking",
            type: "pass_completed",
            pass_id: proposals.pass_id,
            observations: proposals.observations.length,
            actions: proposals.proposed_actions.length,
            audits: proposals.proposed_audits.length,
            questions: proposals.open_questions.length,
            nothing_to_report: proposals.nothing_to_report,
          });
          const sapienceActive = await isSapienceActive(workspaceDir);
          if (!sapienceActive) await maybeDeliver(proposals, api, config);
        } catch (err) {
          const passId = (params.proposals as Record<string, unknown>)?.pass_id as string ?? "unknown";
          await appendError(passId, err instanceof ParseError ? err.message : String(err), config.output.logPath);
        } finally {
          await releaseLock(lockFile);
        }
        return { content: [{ type: "text", text: "SILENT_REPLY_TOKEN" }] };
      },
    });

  },
});

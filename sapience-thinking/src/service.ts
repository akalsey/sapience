import { join } from "path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";

import { buildContext, resolveContextDirs, getLastThreePasses } from "./context-builder.js";
import { buildPrompt } from "./prompt-builder.js";
import { parseProposals, ParseError } from "./output-parser.js";
import { appendPass, appendError, appendSkipped, appendStructuredProposals } from "./log-writer.js";
import { appendEvent } from "./events.js";
import { loadOutcomes, saveOutcomes, addProposals, expireOldProposals, purgeResolvedOutcomes } from "./outcome-tracker.js";
import { computeSignal } from "./signal-analyzer.js";
import { maybeDeliver } from "./delivery.js";
import { DEFAULT_CONFIG, type PluginConfig } from "./types.js";
import { resolveDataPath } from "./utils.js";
import { writeStatusArtifact, resolvePluginVersion } from "./status-artifact.js";
import { acquireLock, releaseLock, clearLock } from "./lock.js";
import { isSapienceActive } from "./presence.js";
import { validateActiveHours, isWithinActiveHours } from "./active-hours.js";
import { rotateKeepingTail } from "./rotate.js";
import { logSkipOnce, clearSkipState } from "./skip-log.js";
import { recordOutcome, RECORDABLE_OUTCOMES, type RecordableOutcome } from "./outcome-recorder.js";
import { dedupeProposals } from "./dedup.js";
import { loadPlaybooks } from "./playbooks.js";

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

    // Invalid activeHours used to disable the plugin silently (NaN comparisons)
    // or throw on every run (bad timezone). Fall back to defaults, loudly.
    const hoursCheck = validateActiveHours(config.activeHours, DEFAULT_CONFIG.activeHours);
    config.activeHours = hoursCheck.hours;
    if (hoursCheck.errors.length > 0) {
      void appendEvent(config.output.eventsPath, {
        plugin: "thinking", type: "config_invalid", field: "activeHours", errors: hoursCheck.errors, using: "defaults",
      }).catch(() => {});
    }

    const lockFile = join(workspaceDir, "proactive-thinking", ".pass.lock");
    const skipStatePath = join(workspaceDir, "proactive-thinking", ".skip-state.json");
    const agentId: string = ((api.config as Record<string, unknown>)?.agent as Record<string, unknown>)?.id as string ?? "default";

    // A gateway restart means no pass can be running; drop any leftover lock.
    void clearLock(lockFile).catch(() => {});

    // Record what this plugin actually resolved, for `openclaw sapience doctor`.
    // Context dirs included: passes that read from the wrong places ran blind
    // for weeks with nothing observable — now the doctor can see the inputs.
    const contextDirs = resolveContextDirs(api, agentId);
    void writeStatusArtifact({
      pluginId: "sapience-thinking",
      version: resolvePluginVersion(),
      agentId,
      resolvedWorkspaceDir: workspaceDir,
      outputPaths: {
        ...(config.output as unknown as Record<string, string>),
        contextSessionsDir: contextDirs.sessionsDir,
        contextMemoryDirs: contextDirs.memoryDirs.join(", "),
      },
      initAt: new Date().toISOString(),
    }).catch(() => {});

    api.registerTool({
      name: "get_thinking_context",
      description: "Fetch context bundle and thinking instructions. Call this first in every thinking pass.",
      parameters: Type.Object({}),
      async execute(_id: any, _params: any) {
        if (!isWithinActiveHours(config.activeHours)) {
          await logSkipOnce(skipStatePath, "outside_hours", () =>
            appendEvent(config.output.eventsPath, { plugin: "thinking", type: "pass_skipped", reason: "outside_hours" }));
          return { content: [{ type: "text", text: JSON.stringify({ status: "skip", reason: "outside_active_hours" }) }] };
        }
        const acquired = await acquireLock(lockFile);
        if (!acquired) {
          await appendSkipped("pass_already_running", config.output.logPath);
          await appendEvent(config.output.eventsPath, { plugin: "thinking", type: "pass_skipped", reason: "already_running" });
          return { content: [{ type: "text", text: JSON.stringify({ status: "skip", reason: "pass_already_running" }) }] };
        }
        try {
          const [bundle, recentPasses, outcomes, playbooks] = await Promise.all([
            buildContext(config, api, agentId, workspaceDir),
            getLastThreePasses(config.output.logPath),
            loadOutcomes(config.output.trackerPath),
            loadPlaybooks(join(workspaceDir, "sapience", "playbooks.json")),
          ]);
          bundle.recentPasses = recentPasses;
          const signal = config.learning.adjustPromptBasedOnSignal ? computeSignal(outcomes, config) : null;
          const prompt = buildPrompt(bundle, signal, playbooks);
          return { content: [{ type: "text", text: prompt }] };
        } catch (err) {
          await releaseLock(lockFile);
          throw err;
        }
      },
    });

    api.registerTool({
      name: "record_outcome",
      description: "Record the user's reaction to a delivered proposal (acted_on, accepted, rejected, or acknowledged). Call this after the user responds to a surfaced proposal — it is how the autonomy system learns.",
      parameters: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "The proposal id from the delivered prompt" },
          outcome: { type: "string", enum: [...RECORDABLE_OUTCOMES], description: "acted_on/accepted when the user did it or said yes; rejected when they declined; acknowledged when they saw it but deferred" },
          domain: { type: "string", description: "The proposal's domain, from the delivered prompt" },
          action_class: { type: "string", description: "The proposal's action class, from the delivered prompt" },
        },
        required: ["proposal_id", "outcome"],
      },
      async execute(_id: any, params: any) {
        try {
          const outcome = params?.outcome as RecordableOutcome;
          if (!RECORDABLE_OUTCOMES.includes(outcome)) {
            return { content: [{ type: "text", text: `Invalid outcome "${String(params?.outcome)}". Valid outcomes: ${RECORDABLE_OUTCOMES.join(", ")}.` }] };
          }
          const proposalId = typeof params?.proposal_id === "string" ? params.proposal_id.trim() : "";
          if (!proposalId) return { content: [{ type: "text", text: "record_outcome requires a proposal_id." }] };
          const result = await recordOutcome(config.output.trackerPath, workspaceDir, {
            proposalId,
            outcome,
            domain: typeof params?.domain === "string" ? params.domain : undefined,
            actionClass: typeof params?.action_class === "string" ? params.action_class : undefined,
          });
          if (result.ok) {
            await appendEvent(config.output.eventsPath, {
              plugin: "thinking", type: "outcome_recorded",
              proposal_id: proposalId, outcome,
              domain: params?.domain, action_class: params?.action_class,
            });
          }
          return { content: [{ type: "text", text: result.message }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[thinking] record_outcome error: ${String(err)}` }] };
        }
      },
    });

    api.registerTool({
      name: "record_thinking_output",
      description: "Record structured thinking proposals from this pass. Call after get_thinking_context.",
      parameters: Type.Object({ proposals: Type.Unknown() }),
      async execute(_id: any, params: any) {
        try {
          const raw = parseProposals(params.proposals);
          // Drop near-duplicates of recent history (pending, dismissed, or
          // expired within the window) before anything is recorded or routed.
          const history = await loadOutcomes(config.output.trackerPath);
          const { kept: proposals, dropped } = dedupeProposals(raw, history);
          if (dropped > 0) {
            await appendEvent(config.output.eventsPath, { plugin: "thinking", type: "proposals_deduped", pass_id: proposals.pass_id, dropped });
          }
          await appendPass(proposals, config.output.logPath);
          await appendStructuredProposals(proposals, config.output.proposalsPath);
          if (config.learning.trackOutcomes) {
            let outcomes = addProposals(history, proposals);
            outcomes = expireOldProposals(outcomes);
            outcomes = purgeResolvedOutcomes(outcomes);
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
          // Delivery problems are not parse errors — keep them out of the
          // pass log's "parse error" bucket and in the event stream instead.
          let sapienceActive = false;
          try {
            sapienceActive = await isSapienceActive(workspaceDir);
            if (!sapienceActive) await maybeDeliver(proposals, api, config);
          } catch (err) {
            await appendEvent(config.output.eventsPath, { plugin: "thinking", type: "delivery_failed", reason: String(err) }).catch(() => {});
          }

          // Bound the append-only files. Safe here: we hold the pass lock and
          // are the only writer of the log and sidecar. Events are normally
          // rotated by sapience's dashboard; standalone installs rotate here.
          await clearSkipState(skipStatePath).catch(() => {});
          await rotateKeepingTail(config.output.logPath).catch(() => {});
          await rotateKeepingTail(config.output.proposalsPath).catch(() => {});
          if (!sapienceActive) await rotateKeepingTail(config.output.eventsPath).catch(() => {});
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

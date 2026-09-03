import { join } from "path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readRuntime } from "./safe-runtime.js";
import { resolveAgentId, resolveRegistrableAgentId } from "./resolve-agent.js";
import { Type } from "@sinclair/typebox";

import { buildContext, resolveContextDirs, getLastThreePasses } from "./context-builder.js";
import { buildPrompt } from "./prompt-builder.js";
import { normalizeProposals, ParseError } from "./output-parser.js";
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
import { scheduleAudit } from "./audit-scheduler.js";
import { TurnWatcher, installTurnWatcher, buildNoticerPrompt, parseNoticedObservations, recordNoticedObservations } from "./noticer.js";
import { readDeliveryStatus, formatDeliveryWarning } from "./delivery-status.js";

// How far back unresolved delivery failures still color a pass's view of user
// silence. Longer than the context lookback: a pipe that died yesterday still
// explains why today's proposals sit unacknowledged.
const DELIVERY_STATUS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

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
    noticing: { ...DEFAULT_CONFIG.noticing, ...((raw.noticing as object) ?? {}) },
    learning: { ...DEFAULT_CONFIG.learning, ...((raw.learning as object) ?? {}) },
    skillsDirs: (Array.isArray(raw.skillsDirs) ? (raw.skillsDirs as string[]) : DEFAULT_CONFIG.skillsDirs)
      .filter((d): d is string => typeof d === "string" && d.trim() !== "")
      .map((d) => resolveDataPath(d, workspaceDir, d)),
  };
}

export default definePluginEntry({
  id: "sapience-thinking",
  name: "Sapience Thinking",
  description: "Periodic isolated thinking passes that produce structured proposals",

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
          pluginId: "sapience-thinking",
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
    // This used to read `config.agent.id`, a key no OpenClaw config has — the
    // roster lives under `agents.entries` — so the literal fallback decided
    // every time, and passes resolved a sessions path that had never existed.
    // resolveAgentId reads the roster openclaw actually ships.
    const agentId: string = resolveAgentId(api.config);

    // A gateway restart means no pass can be running; drop any leftover lock.
    void clearLock(lockFile).catch(() => {});

    // Record what this plugin actually resolved, for `openclaw sapience doctor`.
    // Context dirs included: passes that read from the wrong places ran blind
    // for weeks with nothing observable — now the doctor can see the inputs.
    // Refreshed on every cron run as a liveness heartbeat: register-time-only
    // artifacts made the doctor call healthy plugins "stale" on any gateway
    // that had simply been up longer than the staleness window.
    // Recording the path was not enough on its own: the artifact faithfully
    // reported a sessions dir that had never existed and no one noticed,
    // because a path is only observable if something asserts it resolves.
    // contextSessionsDirExists is that assertion.
    const touchArtifact = async () => {
      const contextDirs = await resolveContextDirs(api, agentId);
      return writeStatusArtifact({
        pluginId: "sapience-thinking",
        version: resolvePluginVersion(),
        agentId,
        resolvedWorkspaceDir: workspaceDir,
        outputPaths: {
          ...(config.output as unknown as Record<string, string>),
          contextSessionsDir: contextDirs.sessionsDir,
          contextSessionsDirExists: String(contextDirs.sessionsDirExists),
          contextMemoryDirs: contextDirs.memoryDirs.join(", "),
        },
        initAt: new Date().toISOString(),
      }).catch(() => {});
    };
    void touchArtifact().catch(() => {});

    // Post-task incidental noticing: peripheral vision over live sessions.
    const subscribeTranscripts = api?.runtime?.events?.onSessionTranscriptUpdate;
    const llmComplete = api?.runtime?.llm?.complete;
    if (config.noticing.enabled && typeof subscribeTranscripts === "function" && typeof llmComplete === "function") {
      // installTurnWatcher, not `new TurnWatcher` + subscribe: register() runs
      // several times in one gateway process and every extra subscription was
      // another full side-pass over the same turn. See noticer.ts. It owns the
      // subscribe call, so there is deliberately no separate subscribe here.
      let watcher: TurnWatcher | undefined;
      const options = {
        minTurnChars: config.noticing.minTurnChars,
        cooldownMs: config.noticing.cooldownMinutes * 60 * 1000,
        onTurn: (sessionKey: string, turnText: string) => {
          void (async () => {
            try {
              const { text } = await llmComplete({
                messages: [{ role: "user", content: buildNoticerPrompt(turnText) }],
                maxTokens: 600,
                purpose: "sapience post-task noticing",
              });
              const observations = parseNoticedObservations(text);
              if (observations.length === 0) return;
              const recorded = await recordNoticedObservations(observations, {
                proposalsPath: config.output.proposalsPath,
                trackerPath: config.output.trackerPath,
                sessionKey,
              });
              if (recorded) {
                await appendEvent(config.output.eventsPath, {
                  plugin: "thinking", type: "noticed",
                  session: sessionKey, observations: recorded.observations.length,
                  // Provenance for the duplicate-side-pass investigation; see
                  // the note on TurnWatcher.instanceId.
                  watcher: watcher?.instanceId, pid: process.pid,
                });
              }
            } catch { /* peripheral vision must never disturb the main flow */ }
          })();
        },
      };
      try {
        watcher = installTurnWatcher(subscribeTranscripts, options);
      } catch { /* subscription unavailable */ }
    }

    api.registerTool({
      name: "get_thinking_context",
      description: "Fetch context bundle and thinking instructions. Call this first in every thinking pass.",
      parameters: Type.Object({}),
      async execute(_id: any, _params: any) {
        void touchArtifact().catch(() => {});
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
          const deliveryStatus = await readDeliveryStatus(config.output.eventsPath, Date.now() - DELIVERY_STATUS_LOOKBACK_MS);
          bundle.deliveryWarning = formatDeliveryWarning(deliveryStatus);
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
            // Queued siblings retired by this answer. Logged so a queue that
            // silently empties is distinguishable from one that never filled.
            if (result.staleDropped?.length) {
              await appendEvent(config.output.eventsPath, {
                plugin: "thinking", type: "stale_deliveries_dropped",
                proposal_id: proposalId, dropped: result.staleDropped.length,
                dropped_ids: result.staleDropped,
              });
            }
            // An accepted audit becomes recurring coverage: register the cron.
            const positive = outcome === "accepted" || outcome === "acted_on";
            if (positive && result.record?.proposal_type === "audit" && result.record.text) {
              // Registrable, not resolved: pass a name only when the roster
              // really has one, so the job never stores a guess it cannot run.
              const scheduled = await scheduleAudit(result.record.text, resolveRegistrableAgentId(api.config));
              await appendEvent(config.output.eventsPath, {
                plugin: "thinking",
                type: scheduled.ok ? "audit_scheduled" : "audit_schedule_failed",
                cron: scheduled.name,
                ...(scheduled.error ? { reason: scheduled.error } : {}),
              });
              if (scheduled.ok) {
                return { content: [{ type: "text", text: `${result.message} Registered recurring audit cron "${scheduled.name}" (Mondays 09:00). Tell the user.` }] };
              }
            }
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
          // Tolerant normalization: the model is sloppy about the envelope
          // (missing pass_id/timestamp/estimated_effort, half-formed items).
          // Recover what's usable instead of rejecting the whole pass.
          const { proposals: raw, dropped: coerced } = normalizeProposals(params.proposals);
          if (coerced > 0) {
            await appendEvent(config.output.eventsPath, { plugin: "thinking", type: "proposals_coerced", pass_id: raw.pass_id, dropped_items: coerced });
          }
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
        return { content: [{ type: "text", text: "NO_REPLY" }] };
      },
    });

  },
});

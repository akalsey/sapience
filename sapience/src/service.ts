// src/service.ts
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, type SapienceConfig } from "./types.js";
import { resolveDataPath } from "./utils.js";
import { validateActiveHours, isWithinActiveHours } from "./active-hours.js";
import { loadProfile, saveProfile, upsertEntry, addMissingEntries } from "./calibration.js";
import { routeItem } from "./autonomy.js";
import { readUnprocessedPasses, proposalSetToItems } from "./proposal-adapter.js";
import { loadProcessedPasses, markPassProcessed, bootstrapProcessedPasses } from "./processed-passes.js";
import { deliverItems } from "./delivery.js";
import { digestDue, buildDigestPrompt } from "./weekly-digest.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";
import { acquireLock, releaseLock, clearLock } from "./lock.js";
import { rotateKeepingTail } from "./rotate.js";
import { logSkipOnce, clearSkipState } from "./skip-log.js";
import { appendEvent } from "./events.js";
import { generateDashboard } from "./dashboard.js";
import { writeStatusArtifact, resolvePluginVersion } from "./status-artifact.js";
import { enqueueMainSessionInjection } from "./main-session.js";
import { requestChannelPush } from "./push.js";
import { investigateHunches } from "./investigation.js";
import { compileExtraDomains } from "./domains.js";
import { registerSapienceDoctorCli } from "./doctor/cli.js";

function mergeConfig(raw: Record<string, unknown>, workspaceDir: string): SapienceConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<SapienceConfig>),
    activeHours: { ...DEFAULT_CONFIG.activeHours, ...((raw.activeHours as object) ?? {}) },
    proactiveThinking: {
      ...DEFAULT_CONFIG.proactiveThinking,
      ...((raw.proactiveThinking as object) ?? {}),
      proposalsPath: resolveDataPath((raw as any).proactiveThinking?.proposalsPath, workspaceDir, DEFAULT_CONFIG.proactiveThinking.proposalsPath),
    },
    learning: { ...DEFAULT_CONFIG.learning, ...((raw.learning as object) ?? {}) },
    autonomy: { ...DEFAULT_CONFIG.autonomy, ...((raw.autonomy as object) ?? {}) },
    digest: { ...DEFAULT_CONFIG.digest, ...((raw.digest as object) ?? {}) },
    push: { ...DEFAULT_CONFIG.push, ...((raw.push as object) ?? {}) },
    output: {
      ...DEFAULT_CONFIG.output,
      ...((raw.output as object) ?? {}),
      calibrationPath: resolveDataPath((raw as any).output?.calibrationPath, workspaceDir, DEFAULT_CONFIG.output.calibrationPath),
      actionLogPath: resolveDataPath((raw as any).output?.actionLogPath, workspaceDir, DEFAULT_CONFIG.output.actionLogPath),
      processedPassesPath: resolveDataPath((raw as any).output?.processedPassesPath, workspaceDir, DEFAULT_CONFIG.output.processedPassesPath),
      eventsPath: resolveDataPath((raw as any).output?.eventsPath, workspaceDir, DEFAULT_CONFIG.output.eventsPath),
      dashboardPath: resolveDataPath((raw as any).output?.dashboardPath, workspaceDir, DEFAULT_CONFIG.output.dashboardPath),
      goalsPath: resolveDataPath((raw as any).output?.goalsPath, workspaceDir, DEFAULT_CONFIG.output.goalsPath),
      pushStatePath: resolveDataPath((raw as any).output?.pushStatePath, workspaceDir, DEFAULT_CONFIG.output.pushStatePath),
      investigationStatePath: resolveDataPath((raw as any).output?.investigationStatePath, workspaceDir, DEFAULT_CONFIG.output.investigationStatePath),
      hypothesesPath: resolveDataPath((raw as any).output?.hypothesesPath, workspaceDir, DEFAULT_CONFIG.output.hypothesesPath),
    },
  };
}

export default definePluginEntry({
  id: "sapience",
  name: "Sapience",
  description: "Autonomy layer: routes sapience-thinking proposals through tier function, calibrates to human preferences, delivers weekly digest",

  register(api: any) {
    // Register the CLI before the workspace guard below: OpenClaw collects CLI
    // registrars by calling register() with an empty runtime, so the guard throws
    // and bails there. CLI registration needs no workspace.
    if (typeof api.registerCli === "function") registerSapienceDoctorCli(api);

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
        plugin: "sapience", type: "config_invalid", field: "activeHours", errors: hoursCheck.errors, using: "defaults",
      }).catch(() => {});
    }

    const extraDomains = compileExtraDomains((api.pluginConfig as Record<string, unknown>)?.domains);

    // Write presence marker synchronously so sapience-thinking's .present check is race-free.
    // It is refreshed on every routing run; thinking treats a stale marker as "router gone".
    const markerDir = join(workspaceDir, "sapience");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, ".present"), "", "utf-8");
    const lockFile = join(markerDir, ".routing.lock");
    const digestStatePath = join(markerDir, "digest-state.json");
    const skipStatePath = join(markerDir, ".skip-state.json");
    void clearLock(lockFile).catch(() => {});

    // Record what this plugin actually resolved, so `openclaw sapience doctor` can
    // report production reality (not a recomputation). Fire-and-forget.
    void writeStatusArtifact({
      pluginId: "sapience",
      version: resolvePluginVersion(),
      agentId: ((api.config as Record<string, unknown>)?.agent as Record<string, unknown>)?.id as string ?? "default",
      resolvedWorkspaceDir: workspaceDir,
      outputPaths: config.output as unknown as Record<string, string>,
      initAt: new Date().toISOString(),
    }).catch(() => {});

    api.registerTool({
      name: "process_proposals",
      description: "Process new proposals from the sapience-thinking log and route them through the autonomy tier function. Called by the sapience cron.",
      parameters: { type: "object", properties: {} },
      async execute(_id: any, _params: any) {
        try {
          if (!isWithinActiveHours(config.activeHours)) {
            await logSkipOnce(skipStatePath, "outside_hours", () =>
              appendEvent(config.output.eventsPath, { plugin: "sapience", type: "routing_skipped", reason: "outside_hours" }));
            await generateDashboard(config).catch(() => {});
            return { content: [{ type: "text", text: "SILENT_REPLY_TOKEN" }] };
          }

          // Overlapping routing runs double-deliver and clobber each other's
          // calibration writes; skip if another run holds the lock.
          const acquired = await acquireLock(lockFile);
          if (!acquired) {
            await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "routing_skipped", reason: "already_running" });
            return { content: [{ type: "text", text: "SILENT_REPLY_TOKEN" }] };
          }

          try {
            // Refresh the presence marker: sapience-thinking treats a marker
            // older than 2h as "router gone" and falls back to self-delivery.
            writeFileSync(join(markerDir, ".present"), "", "utf-8");

            let processed = await loadProcessedPasses(config.output.processedPassesPath);
            const profile = await loadProfile(config.output.calibrationPath);

            // On first run, mark all existing passes as processed to avoid re-delivering stale proposals
            if (processed.size === 0) {
              processed = await bootstrapProcessedPasses(
                config.proactiveThinking.proposalsPath,
                config.output.processedPassesPath,
              );
            }

            const newPasses = await readUnprocessedPasses(
              config.proactiveThinking.proposalsPath,
              processed
            );

            let updatedProcessed = processed;
            // Routing only ever ADDS calibration entries. Collect them and merge
            // against a freshly loaded profile at the end — saving the profile
            // snapshot from the top of the run silently reverted any confidence
            // change sapience-feedback applied while this run was in flight.
            let workingProfile = profile;
            const newEntries: typeof profile = [];
            let totalItems = 0;
            const byTier: Record<string, number> = {};

            for (const pass of newPasses) {
              const items = proposalSetToItems(pass, extraDomains);
              const routed = items.map(item => routeItem(item, workingProfile, config));
              // Hunches worth surfacing get a bounded read-only check first;
              // supported ones upgrade and re-route, refuted ones drop.
              const investigated = await investigateHunches(routed, api, config,
                (item) => routeItem(item, workingProfile, config));

              await deliverItems(investigated, api, config);
              updatedProcessed = await markPassProcessed(pass.pass_id, config.output.processedPassesPath, updatedProcessed);

              for (const item of investigated) {
                totalItems++;
                byTier[item.tier] = (byTier[item.tier] ?? 0) + 1;
                const exists = workingProfile.find(e => e.domain === item.domain && e.action_class === item.action_class);
                if (!exists) {
                  workingProfile = upsertEntry(workingProfile, item.domain, item.action_class, {
                    tier: config.autonomy.defaultTier,
                    confidence: 0,
                  });
                  newEntries.push(workingProfile.find(e => e.domain === item.domain && e.action_class === item.action_class)!);
                  await appendEvent(config.output.eventsPath, {
                    plugin: "sapience",
                    type: "calibration_change",
                    domain: item.domain,
                    action_class: item.action_class,
                    old_confidence: null,
                    new_confidence: 0,
                    old_tier: null,
                    new_tier: config.autonomy.defaultTier,
                    source: "new_entry",
                  });
                }
              }
            }

            if (newEntries.length > 0) {
              const fresh = await loadProfile(config.output.calibrationPath);
              await saveProfile(addMissingEntries(fresh, newEntries), config.output.calibrationPath);
            }

            if (newPasses.length === 0) {
              await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "routing_skipped", reason: "no_new_passes" });
            } else {
              await appendEvent(config.output.eventsPath, {
                plugin: "sapience",
                type: "routing_completed",
                passes: newPasses.length,
                items: totalItems,
                by_tier: byTier,
              });
            }

            if (config.digest.enabled) {
              const digestState = await readJsonSafe<{ lastSentDate: string | null }>(digestStatePath, { lastSentDate: null });
              const { due, localDate } = digestDue(config, digestState.lastSentDate);
              if (due) {
                const prompt = await buildDigestPrompt(config);
                const digestResult = await enqueueMainSessionInjection(api, prompt);
                if (digestResult.enqueued) {
                  await writeJsonAtomic(digestStatePath, { lastSentDate: localDate });
                  // The digest is weekly — always worth initiating contact for.
                  requestChannelPush(api, "sapience weekly digest");
                  await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "digest_delivered" });
                } else {
                  await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "delivery_failed", what: "digest", reason: digestResult.reason });
                }
              }
            }

            await generateDashboard(config).catch(() => {});
            await clearSkipState(skipStatePath).catch(() => {});
            // Bound the action log; events.jsonl is rotated by generateDashboard.
            await rotateKeepingTail(config.output.actionLogPath).catch(() => {});
          } finally {
            await releaseLock(lockFile);
          }

          return { content: [{ type: "text", text: "SILENT_REPLY_TOKEN" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[sapience] process_proposals error: ${String(err)}` }] };
        }
      },
    });

  },
});

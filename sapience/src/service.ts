// src/service.ts
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, type SapienceConfig } from "./types.js";
import { resolveDataPath, isWithinActiveHours } from "./utils.js";
import { loadProfile, saveProfile, upsertEntry } from "./calibration.js";
import { routeItem } from "./autonomy.js";
import { readUnprocessedPasses, proposalSetToItems } from "./proposal-adapter.js";
import { loadProcessedPasses, markPassProcessed, bootstrapProcessedPasses } from "./processed-passes.js";
import { deliverItems } from "./delivery.js";
import { isDigestDay, buildDigestPrompt } from "./weekly-digest.js";
import { appendEvent } from "./events.js";
import { generateDashboard } from "./dashboard.js";

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
    output: {
      ...DEFAULT_CONFIG.output,
      ...((raw.output as object) ?? {}),
      calibrationPath: resolveDataPath((raw as any).output?.calibrationPath, workspaceDir, DEFAULT_CONFIG.output.calibrationPath),
      actionLogPath: resolveDataPath((raw as any).output?.actionLogPath, workspaceDir, DEFAULT_CONFIG.output.actionLogPath),
      processedPassesPath: resolveDataPath((raw as any).output?.processedPassesPath, workspaceDir, DEFAULT_CONFIG.output.processedPassesPath),
      eventsPath: resolveDataPath((raw as any).output?.eventsPath, workspaceDir, DEFAULT_CONFIG.output.eventsPath),
      dashboardPath: resolveDataPath((raw as any).output?.dashboardPath, workspaceDir, DEFAULT_CONFIG.output.dashboardPath),
      goalsPath: resolveDataPath((raw as any).output?.goalsPath, workspaceDir, DEFAULT_CONFIG.output.goalsPath),
    },
  };
}

export default definePluginEntry({
  id: "sapience",
  name: "Sapience",
  description: "Autonomy layer: routes sapience-thinking proposals through tier function, calibrates to human preferences, delivers weekly digest",

  register(api: any) {
    const workspaceDir = (api.runtime.agent.resolveAgentWorkspaceDir as (cfg: unknown) => string)(api.pluginConfig);
    const config = mergeConfig(api.pluginConfig as Record<string, unknown>, workspaceDir);

    // Write presence marker synchronously so sapience-thinking's .present check is race-free
    const markerDir = join(workspaceDir, "sapience");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, ".present"), "", "utf-8");

    api.registerTool({
      name: "process_proposals",
      description: "Process new proposals from the sapience-thinking log and route them through the autonomy tier function. Called by the sapience cron.",
      parameters: {} as any,
      async execute(_id: any, _params: any) {
        try {
          if (!isWithinActiveHours(config)) {
            await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "routing_skipped", reason: "outside_hours" });
            await generateDashboard(config).catch(() => {});
            return { content: [{ type: "text", text: "SILENT_REPLY_TOKEN" }] };
          }

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
          let updatedProfile = profile;
          let totalItems = 0;
          const byTier: Record<string, number> = {};

          for (const pass of newPasses) {
            const items = proposalSetToItems(pass);
            const routed = items.map(item => routeItem(item, updatedProfile, config));

            await deliverItems(routed, api, config);
            updatedProcessed = await markPassProcessed(pass.pass_id, config.output.processedPassesPath, updatedProcessed);

            for (const item of routed) {
              totalItems++;
              byTier[item.tier] = (byTier[item.tier] ?? 0) + 1;
              const exists = updatedProfile.find(e => e.domain === item.domain && e.action_class === item.action_class);
              if (!exists) {
                updatedProfile = upsertEntry(updatedProfile, item.domain, item.action_class, {
                  tier: config.autonomy.defaultTier,
                  confidence: 0,
                });
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

          await saveProfile(updatedProfile, config.output.calibrationPath);

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

          if (config.digest.enabled && isDigestDay(config)) {
            const prompt = await buildDigestPrompt(config);
            await api.session.workflow.enqueueNextTurnInjection({ sessionTarget: "main", text: prompt });
            await appendEvent(config.output.eventsPath, { plugin: "sapience", type: "digest_delivered" });
          }

          await generateDashboard(config).catch(() => {});

          return { content: [{ type: "text", text: "SILENT_REPLY_TOKEN" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[sapience] process_proposals error: ${String(err)}` }] };
        }
      },
    });

  },
});

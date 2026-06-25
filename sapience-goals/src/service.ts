// src/service.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, type GoalsConfig, type Goal } from "./types.js";
import { resolveDataPath, generateId, isWithinActiveHours, nextWeeklyDate } from "./utils.js";
import { loadGoals, saveGoals, addGoal, updateNextDelivery } from "./goal-store.js";
import { readNewGoals, savePosition } from "./inbox-reader.js";
import { deliverDecomposition, deliverWeeklyStatus } from "./delivery.js";
import { appendEvent } from "./events.js";

function mergeConfig(raw: Record<string, unknown>, workspaceDir: string): GoalsConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<GoalsConfig>),
    activeHours: { ...DEFAULT_CONFIG.activeHours, ...((raw.activeHours as object) ?? {}) },
    output: {
      ...DEFAULT_CONFIG.output,
      ...((raw.output as object) ?? {}),
      goalsPath: resolveDataPath((raw as any).output?.goalsPath, workspaceDir, DEFAULT_CONFIG.output.goalsPath),
      eventsPath: resolveDataPath((raw as any).output?.eventsPath, workspaceDir, DEFAULT_CONFIG.output.eventsPath),
    },
    inboxPath: resolveDataPath((raw as any).inboxPath, workspaceDir, DEFAULT_CONFIG.inboxPath),
    inboxPositionPath: resolveDataPath((raw as any).inboxPositionPath, workspaceDir, DEFAULT_CONFIG.inboxPositionPath),
  };
}

function isWeeklyCheckInDue(goal: Goal): boolean {
  return goal.status === "active" && new Date(goal.next_status_delivery) <= new Date();
}

export default definePluginEntry({
  id: "sapience-goals",
  name: "Sapience Goals",
  description: "Persistent fuzzy goal tracking with weekly status delivery",

  register(api: any) {
    let workspaceDir: string;
    try {
      workspaceDir = (api.runtime.agent.resolveAgentWorkspaceDir as (cfg: unknown) => string)(api.pluginConfig);
    } catch { return; }
    const config = mergeConfig(api.pluginConfig as Record<string, unknown>, workspaceDir);

    api.registerTool({
      name: "goal_submit",
      description: "Submit a new long-running goal. Call this when the user expresses a fuzzy objective that spans multiple sessions. Returns the new goal's id.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "The goal as stated by the user — fuzzy and long-running is fine" },
        },
        required: ["description"],
      },
      async execute(_id: any, params: any) {
        try {
          const { description } = params as { description: string };
          let goals = await loadGoals(config.output.goalsPath);
          const goal: Goal = {
            id: generateId(),
            description,
            decomposed_approaches: [],
            active_approach: "",
            status: "decomposing",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            progress_notes: [],
            blockers: [],
            next_status_delivery: nextWeeklyDate(
              config.weeklyCheckInDay,
              config.weeklyCheckInTime,
              config.activeHours.timezone
            ),
          };
          goals = addGoal(goals, goal);
          await saveGoals(goals, config.output.goalsPath);
          await deliverDecomposition(description, api);
          await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_created", goal_id: goal.id });
          return { content: [{ type: "text", text: JSON.stringify({ id: goal.id }) }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[goals] goal_submit error: ${String(err)}` }] };
        }
      },
    });

    api.registerTool({
      name: "check_goals",
      description: "Check inbox for new goals and deliver weekly status for active goals. Called by the goals cron.",
      parameters: {} as any,
      async execute(_id: any, _params: any) {
        try {
          if (!isWithinActiveHours(config)) {
            await appendEvent(config.output.eventsPath, { plugin: "goals", type: "check_skipped", reason: "outside_hours" });
            return { content: [{ type: "text", text: "SILENT_REPLY_TOKEN" }] };
          }

          let goals = await loadGoals(config.output.goalsPath);

          const { goals: newDescriptions, newPosition } = await readNewGoals(
            config.inboxPath,
            config.inboxPositionPath
          );

          for (const description of newDescriptions) {
            const goal: Goal = {
              id: generateId(),
              description,
              decomposed_approaches: [],
              active_approach: "",
              status: "decomposing",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              progress_notes: [],
              blockers: [],
              next_status_delivery: nextWeeklyDate(
                config.weeklyCheckInDay,
                config.weeklyCheckInTime,
                config.activeHours.timezone
              ),
            };
            goals = addGoal(goals, goal);
            await deliverDecomposition(description, api);
            await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_created", goal_id: goal.id });
          }

          if (newDescriptions.length > 0) {
            await savePosition(newPosition, config.inboxPositionPath);
          }

          let delivered = 0;
          for (const goal of goals) {
            if (isWeeklyCheckInDue(goal)) {
              await deliverWeeklyStatus(goal, api);
              delivered++;
              await appendEvent(config.output.eventsPath, { plugin: "goals", type: "status_delivered", goal_id: goal.id });
              goals = updateNextDelivery(
                goals,
                goal.id,
                nextWeeklyDate(config.weeklyCheckInDay, config.weeklyCheckInTime, config.activeHours.timezone)
              );
            }
          }

          await saveGoals(goals, config.output.goalsPath);
          if (newDescriptions.length === 0 && delivered === 0) {
            await appendEvent(config.output.eventsPath, { plugin: "goals", type: "check_skipped", reason: "nothing_due" });
          }
          return { content: [{ type: "text", text: "SILENT_REPLY_TOKEN" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `[goals] check_goals error: ${String(err)}` }] };
        }
      },
    });

  },
});

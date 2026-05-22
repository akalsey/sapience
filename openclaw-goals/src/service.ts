// src/service.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, type GoalsConfig, type Goal } from "./types.js";
import { resolveDataPath, generateId, isWithinActiveHours, nextWeeklyDate } from "./utils.js";
import { loadGoals, saveGoals, addGoal, updateNextDelivery } from "./goal-store.js";
import { readNewGoals, savePosition } from "./inbox-reader.js";
import { deliverDecomposition, deliverWeeklyStatus } from "./delivery.js";

function mergeConfig(raw: Record<string, unknown>, workspaceDir: string): GoalsConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<GoalsConfig>),
    activeHours: { ...DEFAULT_CONFIG.activeHours, ...((raw.activeHours as object) ?? {}) },
    output: {
      ...DEFAULT_CONFIG.output,
      ...((raw.output as object) ?? {}),
      goalsPath: resolveDataPath((raw as any).output?.goalsPath, workspaceDir, DEFAULT_CONFIG.output.goalsPath),
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
    const workspaceDir = (api.runtime.agent.resolveAgentWorkspaceDir as (cfg: unknown) => string)(api.pluginConfig);
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
        return { content: [{ type: "text", text: JSON.stringify({ id: goal.id }) }] };
      },
    });

    api.registerTool({
      name: "check_goals",
      description: "Check inbox for new goals and deliver weekly status for active goals. Called by the goals cron.",
      parameters: {} as any,
      async execute(_id: any, _params: any) {
        if (!isWithinActiveHours(config)) {
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
        }

        if (newDescriptions.length > 0) {
          await savePosition(newPosition, config.inboxPositionPath);
        }

        for (const goal of goals) {
          if (isWeeklyCheckInDue(goal)) {
            await deliverWeeklyStatus(goal, api);
            goals = updateNextDelivery(
              goals,
              goal.id,
              nextWeeklyDate(config.weeklyCheckInDay, config.weeklyCheckInTime, config.activeHours.timezone)
            );
          }
        }

        await saveGoals(goals, config.output.goalsPath);
        return { content: [{ type: "text", text: "SILENT_REPLY_TOKEN" }] };
      },
    });

    (api.session.workflow as any).scheduleSessionTurn({
      schedule: { cron: config.schedule },
      sessionTarget: "isolated",
      tag: "sapience-goals-check-pass",
      systemPrompt: `You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply SILENT_REPLY_TOKEN after the tool call.`,
      maxTurns: 2,
    });
  },
});

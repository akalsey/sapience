// src/service.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, type GoalsConfig, type Goal, type GoalStatus } from "./types.js";
import { resolveDataPath, generateId, nextWeeklyDate } from "./utils.js";
import { validateActiveHours, isWithinActiveHours } from "./active-hours.js";
import {
  loadGoals, saveGoals, addGoal, updateNextDelivery,
  setActiveApproach, updateGoalStatus, addProgressNote, addBlocker, setGoalMetric,
} from "./goal-store.js";
import { readNewGoals, savePosition } from "./inbox-reader.js";
import { deliverDecomposition, deliverWeeklyStatus } from "./delivery.js";
import { appendEvent } from "./events.js";
import { writeStatusArtifact, resolvePluginVersion } from "./status-artifact.js";
import { logSkipOnce, clearSkipState } from "./skip-log.js";

const GOAL_STATUSES: readonly GoalStatus[] = ["decomposing", "active", "paused", "completed", "abandoned"];
const MAX_DESCRIPTION_LENGTH = 2000;

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

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
    } catch (err) {
      // In CLI-collection context the runtime is empty and this bail is
      // expected — stay silent. In a REAL gateway runtime a failure here is
      // exactly the silent death that left a plugin "vunknown" for 9 days;
      // record it so the doctor can say why.
      if (api?.runtime?.agent) {
        void writeStatusArtifact({
          pluginId: "sapience-goals",
          version: resolvePluginVersion(),
          agentId: "unknown",
          resolvedWorkspaceDir: "",
          outputPaths: {},
          initError: String(err),
          initAt: new Date().toISOString(),
        }).catch(() => {});
      }
      return;
    }
    const config = mergeConfig(api.pluginConfig as Record<string, unknown>, workspaceDir);

    // Invalid activeHours used to disable the plugin silently (NaN comparisons)
    // or throw on every run (bad timezone). Fall back to defaults, loudly.
    const hoursCheck = validateActiveHours(config.activeHours, DEFAULT_CONFIG.activeHours);
    config.activeHours = hoursCheck.hours;
    if (hoursCheck.errors.length > 0) {
      void appendEvent(config.output.eventsPath, {
        plugin: "goals", type: "config_invalid", field: "activeHours", errors: hoursCheck.errors, using: "defaults",
      }).catch(() => {});
    }

    // Record what this plugin actually resolved, for `openclaw sapience doctor`.
    // Refreshed each check_goals run as a liveness heartbeat.
    const touchArtifact = () => writeStatusArtifact({
      pluginId: "sapience-goals",
      version: resolvePluginVersion(),
      agentId: ((api.config as Record<string, unknown>)?.agent as Record<string, unknown>)?.id as string ?? "default",
      resolvedWorkspaceDir: workspaceDir,
      outputPaths: {
        goalsPath: config.output.goalsPath,
        eventsPath: config.output.eventsPath,
        inboxPath: config.inboxPath,
        inboxPositionPath: config.inboxPositionPath,
      },
      initAt: new Date().toISOString(),
    }).catch(() => {});
    void touchArtifact();

    const skipStatePath = resolveDataPath(undefined, workspaceDir, "goals/.skip-state.json");

    // Serialize all goals.json read-modify-write cycles. goal_submit (main
    // session), the lifecycle tools, and check_goals (cron session) run in the
    // same gateway process; unserialized overlap loses whichever save lands
    // first.
    let goalsChain: Promise<unknown> = Promise.resolve();
    function withGoalsLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = goalsChain.then(fn, fn);
      goalsChain = run.catch(() => undefined);
      return run;
    }

    function makeGoal(description: string): Goal {
      return {
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
    }

    // Load → verify the goal exists → mutate → save, under the lock.
    // Returns an error string for the LLM, or null on success.
    async function mutateGoal(id: string, mutate: (goals: Goal[]) => Goal[]): Promise<string | null> {
      return withGoalsLock(async () => {
        const goals = await loadGoals(config.output.goalsPath);
        if (!goals.some(g => g.id === id)) return `No goal with id "${id}". Use check_goals or goals.json to find valid ids.`;
        await saveGoals(mutate(goals), config.output.goalsPath);
        return null;
      });
    }

    api.registerTool({
      name: "goal_select_approach",
      description: "Record the approach the user selected for a goal and mark it active. Call this after the user picks one of the decomposed approaches.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The goal id from the decomposition prompt" },
          approach: { type: "string", description: "The approach the user selected" },
        },
        required: ["id", "approach"],
      },
      async execute(_id: any, params: any) {
        try {
          const id = asTrimmedString(params?.id);
          const approach = asTrimmedString(params?.approach);
          if (!id || !approach) return toolText("goal_select_approach requires non-empty id and approach strings.");
          const err = await mutateGoal(id, (goals) => setActiveApproach(goals, id, approach));
          if (err) return toolText(err);
          await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_activated", goal_id: id });
          return toolText(JSON.stringify({ id, status: "active" }));
        } catch (err) {
          return toolText(`[goals] goal_select_approach error: ${String(err)}`);
        }
      },
    });

    api.registerTool({
      name: "goal_update",
      description: "Update a goal's status (active, paused, completed, abandoned).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The goal id" },
          status: { type: "string", enum: [...GOAL_STATUSES], description: "The new status" },
        },
        required: ["id", "status"],
      },
      async execute(_id: any, params: any) {
        try {
          const id = asTrimmedString(params?.id);
          const status = asTrimmedString(params?.status) as GoalStatus;
          if (!id) return toolText("goal_update requires a goal id.");
          if (!GOAL_STATUSES.includes(status)) return toolText(`Invalid status "${status}". Valid statuses: ${GOAL_STATUSES.join(", ")}.`);
          const err = await mutateGoal(id, (goals) => updateGoalStatus(goals, id, status));
          if (err) return toolText(err);
          await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_status_changed", goal_id: id, status });
          return toolText(JSON.stringify({ id, status }));
        } catch (err) {
          return toolText(`[goals] goal_update error: ${String(err)}`);
        }
      },
    });

    api.registerTool({
      name: "goal_progress",
      description: "Record progress made toward a goal. Call this whenever meaningful work toward an active goal happens.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The goal id" },
          summary: { type: "string", description: "One-line summary of the progress" },
          what_changed: { type: "string", description: "What is different now compared to before" },
        },
        required: ["id", "summary"],
      },
      async execute(_id: any, params: any) {
        try {
          const id = asTrimmedString(params?.id);
          const summary = asTrimmedString(params?.summary);
          if (!id || !summary) return toolText("goal_progress requires non-empty id and summary strings.");
          const note = {
            timestamp: new Date().toISOString(),
            summary,
            actions_taken: [],
            what_changed: asTrimmedString(params?.what_changed),
          };
          const err = await mutateGoal(id, (goals) => addProgressNote(goals, id, note));
          if (err) return toolText(err);
          await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_progress", goal_id: id });
          return toolText(JSON.stringify({ id, recorded: true }));
        } catch (err) {
          return toolText(`[goals] goal_progress error: ${String(err)}`);
        }
      },
    });

    api.registerTool({
      name: "goal_blocker",
      description: "Record something blocking progress on a goal and what it's waiting on.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The goal id" },
          description: { type: "string", description: "What is blocking progress" },
          waiting_on: { type: "string", description: "Who or what the goal is waiting on" },
        },
        required: ["id", "description"],
      },
      async execute(_id: any, params: any) {
        try {
          const id = asTrimmedString(params?.id);
          const description = asTrimmedString(params?.description);
          if (!id || !description) return toolText("goal_blocker requires non-empty id and description strings.");
          const blocker = { description, waiting_on: asTrimmedString(params?.waiting_on) };
          const err = await mutateGoal(id, (goals) => addBlocker(goals, id, blocker));
          if (err) return toolText(err);
          await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_blocked", goal_id: id });
          return toolText(JSON.stringify({ id, recorded: true }));
        } catch (err) {
          return toolText(`[goals] goal_blocker error: ${String(err)}`);
        }
      },
    });

    api.registerTool({
      name: "goal_set_metric",
      description: "Attach a measurable key result to a goal (metric name, numeric target). Weekly statuses then compute progress from data instead of narration.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The goal id" },
          name: { type: "string", description: "Metric name, e.g. 'SMB churn rate'" },
          target: { type: "number", description: "Numeric target value" },
          unit: { type: "string", description: "Unit suffix, e.g. '%'" },
          query_hint: { type: "string", description: "Where/how to fetch the current value" },
          baseline: { type: "number", description: "Starting value, for pace math" },
        },
        required: ["id", "name", "target"],
      },
      async execute(_id: any, params: any) {
        try {
          const id = asTrimmedString(params?.id);
          const name = asTrimmedString(params?.name);
          const target = typeof params?.target === "number" ? params.target : NaN;
          if (!id || !name || !Number.isFinite(target)) {
            return toolText("goal_set_metric requires id, name, and a numeric target.");
          }
          const metric = {
            name, target,
            ...(typeof params?.unit === "string" ? { unit: params.unit } : {}),
            ...(typeof params?.query_hint === "string" ? { query_hint: params.query_hint } : {}),
            ...(typeof params?.baseline === "number" ? { baseline: params.baseline } : {}),
          };
          const err = await mutateGoal(id, (goals) => setGoalMetric(goals, id, metric));
          if (err) return toolText(err);
          await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_metric_set", goal_id: id, metric: name });
          return toolText(JSON.stringify({ id, metric: name, target }));
        } catch (err) {
          return toolText(`[goals] goal_set_metric error: ${String(err)}`);
        }
      },
    });

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
          const description = asTrimmedString(params?.description);
          if (!description) return toolText("goal_submit requires a non-empty description string.");
          if (description.length > MAX_DESCRIPTION_LENGTH) return toolText(`Goal description too long (max ${MAX_DESCRIPTION_LENGTH} characters).`);
          const goal = makeGoal(description);
          await withGoalsLock(async () => {
            const goals = await loadGoals(config.output.goalsPath);
            await saveGoals(addGoal(goals, goal), config.output.goalsPath);
          });
          const delivery = await deliverDecomposition(goal, api);
          if (!delivery.enqueued) {
            await appendEvent(config.output.eventsPath, { plugin: "goals", type: "delivery_failed", what: "decomposition", goal_id: goal.id, reason: delivery.reason });
          }
          await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_created", goal_id: goal.id });
          return toolText(JSON.stringify({ id: goal.id }));
        } catch (err) {
          return toolText(`[goals] goal_submit error: ${String(err)}`);
        }
      },
    });

    api.registerTool({
      name: "check_goals",
      description: "Check inbox for new goals and deliver weekly status for active goals. Called by the goals cron.",
      parameters: { type: "object", properties: {} },
      async execute(_id: any, _params: any) {
        try {
          void touchArtifact();
          if (!isWithinActiveHours(config.activeHours)) {
            await logSkipOnce(skipStatePath, "outside_hours", () =>
              appendEvent(config.output.eventsPath, { plugin: "goals", type: "check_skipped", reason: "outside_hours" }));
            return toolText("NO_REPLY");
          }
          await clearSkipState(skipStatePath).catch(() => {});

          const { goals: newDescriptions, newPosition } = await readNewGoals(
            config.inboxPath,
            config.inboxPositionPath
          );

          // Persist new goals BEFORE advancing the inbox position: a crash
          // between the two re-reads the same inbox lines next run (harmless
          // duplicates) instead of permanently losing the goals.
          const newGoals = newDescriptions.map(makeGoal);
          if (newGoals.length > 0) {
            await withGoalsLock(async () => {
              const goals = await loadGoals(config.output.goalsPath);
              await saveGoals(newGoals.reduce(addGoal, goals), config.output.goalsPath);
            });
            await savePosition(newPosition, config.inboxPositionPath);
          }

          for (const goal of newGoals) {
            const delivery = await deliverDecomposition(goal, api);
            if (!delivery.enqueued) {
              await appendEvent(config.output.eventsPath, { plugin: "goals", type: "delivery_failed", what: "decomposition", goal_id: goal.id, reason: delivery.reason });
            }
            await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_created", goal_id: goal.id });
          }

          let delivered = 0;
          const due = (await loadGoals(config.output.goalsPath)).filter(isWeeklyCheckInDue);
          for (const goal of due) {
            const delivery = await deliverWeeklyStatus(goal, api);
            if (!delivery.enqueued) {
              // Leave next_status_delivery untouched so the status is retried
              // next run instead of silently skipping a week.
              await appendEvent(config.output.eventsPath, { plugin: "goals", type: "delivery_failed", what: "weekly_status", goal_id: goal.id, reason: delivery.reason });
              continue;
            }
            delivered++;
            await appendEvent(config.output.eventsPath, { plugin: "goals", type: "status_delivered", goal_id: goal.id });
            // Reschedule immediately per goal so a later failure can't
            // re-deliver statuses that already went out.
            await withGoalsLock(async () => {
              const goals = await loadGoals(config.output.goalsPath);
              await saveGoals(
                updateNextDelivery(goals, goal.id, nextWeeklyDate(config.weeklyCheckInDay, config.weeklyCheckInTime, config.activeHours.timezone)),
                config.output.goalsPath
              );
            });
          }

          if (newDescriptions.length === 0 && delivered === 0) {
            await appendEvent(config.output.eventsPath, { plugin: "goals", type: "check_skipped", reason: "nothing_due" });
          }
          return toolText("NO_REPLY");
        } catch (err) {
          return toolText(`[goals] check_goals error: ${String(err)}`);
        }
      },
    });

  },
});

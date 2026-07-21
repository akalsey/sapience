// src/service.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, type GoalsConfig, type Goal, type GoalStatus } from "./types.js";
import { resolveDataPath, generateId, nextWeeklyDate } from "./utils.js";
import { validateActiveHours, isWithinActiveHours } from "./active-hours.js";
import {
  loadGoals, saveGoals, addGoal, updateNextDelivery,
  setActiveApproach, updateGoalStatus, addProgressNote, addBlocker, setGoalMetric,
  setGoalPlan, addTodo, completeTodo,
} from "./goal-store.js";
import { readNewGoals, savePosition } from "./inbox-reader.js";
import { deliverDecomposition, deliverWeeklyStatus } from "./delivery.js";
import { writeGoalSkill, removeGoalSkill } from "./skill-file.js";
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
    skillsDir: resolveDataPath((raw as any).skillsDir, workspaceDir, "skills"),
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
        todos: [],
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
          return toolText([
            `Approach recorded; goal ${id} is active.`,
            "Now compile the goal's plan, in this same turn:",
            "1. Review your memory, skills, and data sources for what is relevant to this goal.",
            "2. Draft STANDING INSTRUCTIONS for yourself — behavioral rules that apply during normal work (e.g. \"when you access PostHog or Bespin, remember the results; compare new results against what you know; try to explain trends or outliers; don't force conclusions from thin data\").",
            "3. List the first few TODOS — concrete steps toward the outcome (baselines to gather, patterns to verify).",
            `4. Save them with goal_plan({id: "${id}", instructions: <the standing instructions>, todos: [<todo texts>]}) — this installs the instructions as a temporary skill active in every session.`,
            "Then summarize the plan for the user in one short paragraph.",
          ].join("\n"));
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
          if (status === "completed" || status === "abandoned") {
            await removeGoalSkill(config.skillsDir, id).catch(() => {});
            if (status === "completed") {
              return toolText(`Goal ${id} completed and its temporary skill retired. Only if this goal produced a recurring analysis worth keeping, offer to distill it into a permanent skill — many goals simply end here, and that is fine.`);
            }
          }
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
          await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_created", goal_id: goal.id });
          // The tool result scripts the same-turn exchange: users expect a
          // plan or clarifying questions in the reply to their goal, not a
          // bare acknowledgment followed by an injected conversation later.
          // (check_goals still nudges goals stuck in "decomposing".)
          return toolText([
            `Goal recorded (id: ${goal.id}).`,
            "This is a long-running goal: the suite's scheduled thinking passes will pursue the chosen approach across weeks, learning and iterating as evidence accumulates. It is NOT a task to complete now — Do not start working on it in this turn.",
            "Respond to the user now, in this same turn:",
            "1. Acknowledge the goal in your own words, as an ongoing commitment rather than a to-do.",
            "2. If anything is ambiguous (which metrics, what cadence, what done looks like), ask one or two clarifying questions.",
            "3. Propose 2-3 concrete, operational approaches — what you would watch, gather, or do on a recurring basis (e.g. \"I'll watch which metric questions you ask so I learn what analysis you care about, then fold that into the weekly gathering\"). Present them as options and wait for the user's pick.",
            `When the user picks or refines an approach, record it with goal_select_approach({id: "${goal.id}", approach: <their choice>}) — that is what steers the recurring background work. If they name a measurable target, record it with goal_set_metric.`,
          ].join("\n"));
        } catch (err) {
          return toolText(`[goals] goal_submit error: ${String(err)}`);
        }
      },
    });

    api.registerTool({
      name: "goal_list",
      description: "List all goals with their ids, status, approach, and open todos. Call this to find a goal's id before using the other goal tools.",
      parameters: { type: "object", properties: {} },
      async execute(_id: any, _params: any) {
        try {
          const goals = await loadGoals(config.output.goalsPath);
          if (goals.length === 0) return toolText("No goals yet.");
          const lines = goals.map((g) => {
            const open = (g.todos ?? []).filter((t) => t.status === "open");
            const parts = [`${g.id} [${g.status}] ${g.description}`];
            if (g.active_approach) parts.push(`  approach: ${g.active_approach}`);
            for (const t of open.slice(0, 5)) parts.push(`  todo: ${t.text}`);
            return parts.join("\n");
          });
          return toolText(lines.join("\n"));
        } catch (err) {
          return toolText(`[goals] goal_list error: ${String(err)}`);
        }
      },
    });

    api.registerTool({
      name: "goal_plan",
      description: "Save a goal's compiled plan: standing instructions (installed as a temporary workspace skill, active in every session) plus the initial todo list. Call after the user approves an approach.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The goal id" },
          instructions: { type: "string", description: "Standing behavioral instructions the agent should follow during normal work while this goal is active" },
          todos: { type: "array", items: { type: "string" }, description: "Initial concrete steps toward the outcome" },
        },
        required: ["id", "instructions"],
      },
      async execute(_id: any, params: any) {
        try {
          const id = asTrimmedString(params?.id);
          const instructions = asTrimmedString(params?.instructions);
          if (!id || !instructions) return toolText("goal_plan requires id and instructions.");
          const todos = Array.isArray(params?.todos) ? params.todos.map(asTrimmedString).filter(Boolean) : [];
          const err = await mutateGoal(id, (goals) => setGoalPlan(goals, id, instructions, todos));
          if (err) return toolText(err);
          const goals = await loadGoals(config.output.goalsPath);
          const goal = goals.find((g) => g.id === id)!;
          const skillPath = await writeGoalSkill(config.skillsDir, goal);
          await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_planned", goal_id: id, todos: todos.length });
          return toolText(`Plan saved; standing instructions installed as a temporary skill at ${skillPath}. ${todos.length} todo(s) seeded. Summarize the plan for the user.`);
        } catch (err) {
          return toolText(`[goals] goal_plan error: ${String(err)}`);
        }
      },
    });

    api.registerTool({
      name: "goal_todo",
      description: "Add a todo to a goal or mark one done. Add todos as new work toward the goal becomes clear; mark them done as they finish. Completing the last open todo starts goal wrap-up.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The goal id" },
          action: { type: "string", enum: ["add", "done"], description: "add a new todo, or mark one done" },
          text: { type: "string", description: "The todo text (for add), or the todo's text/id (for done)" },
        },
        required: ["id", "action", "text"],
      },
      async execute(_id: any, params: any) {
        try {
          const id = asTrimmedString(params?.id);
          const action = asTrimmedString(params?.action);
          const text = asTrimmedString(params?.text);
          if (!id || !text || (action !== "add" && action !== "done")) {
            return toolText("goal_todo requires id, action ('add' or 'done'), and text.");
          }
          const err = await mutateGoal(id, (goals) =>
            action === "add" ? addTodo(goals, id, text) : completeTodo(goals, id, text));
          if (err) return toolText(err);
          const goals = await loadGoals(config.output.goalsPath);
          const goal = goals.find((g) => g.id === id)!;
          const open = (goal.todos ?? []).filter((t) => t.status === "open");
          await appendEvent(config.output.eventsPath, { plugin: "goals", type: "goal_todo", goal_id: id, action, open: open.length });
          if (action === "done" && open.length === 0 && (goal.todos ?? []).length > 0) {
            return toolText([
              "All todos are complete.",
              "Confirm with the user whether the goal's outcome has been reached.",
              "If it has: record completion with goal_update — the temporary skill retires automatically. Only when the goal produced a recurring analysis worth repeating should you also offer to distill it into a permanent skill; many goals simply end.",
              "If not: add the next todos with goal_todo.",
            ].join("\n"));
          }
          return toolText(`ok — ${open.length} open todo(s) on goal ${id}.`);
        } catch (err) {
          return toolText(`[goals] goal_todo error: ${String(err)}`);
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

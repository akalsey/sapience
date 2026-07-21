import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import service from "./service.js";

let dir: string;
let api: ReturnType<typeof makeApi>;

function makeApi() {
  const tools = new Map<string, any>();
  const injections: string[] = [];
  return {
    tools,
    injections,
    pluginConfig: {},
    config: {},
    runtime: { agent: { resolveAgentWorkspaceDir: () => dir } },
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    session: {
      workflow: {
        enqueueNextTurnInjection: async (inj: { sessionKey: string; text: string }) => {
          injections.push(inj.text);
          return { enqueued: true, id: "1", sessionKey: inj.sessionKey };
        },
      },
    },
  };
}

async function call(name: string, params: unknown): Promise<string> {
  const tool = api.tools.get(name);
  expect(tool, `tool ${name} should be registered`).toBeDefined();
  const result = await tool.execute("id", params);
  return result.content[0].text as string;
}

async function storedGoals(): Promise<any[]> {
  return JSON.parse(await readFile(join(dir, "goals", "goals.json"), "utf-8"));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "goals-service-"));
  api = makeApi();
  service.register(api as any);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function submitGoal(description: string): Promise<string> {
  const text = await call("goal_submit", { description });
  const m = /id: (goal-[\w-]+)/.exec(text);
  if (!m) throw new Error(`no goal id in: ${text}`);
  return m[1]!;
}

describe("goal lifecycle tools", () => {
  // Goals were created as "decomposing" with no registered tool able to move
  // them forward — weekly status could never fire without hand-editing
  // goals.json. These tools close the lifecycle loop.
  it("registers the full lifecycle: submit, select approach, progress, update, blocker, check", () => {
    for (const name of ["goal_submit", "goal_select_approach", "goal_progress", "goal_update", "goal_blocker", "check_goals"]) {
      expect(api.tools.has(name), name).toBe(true);
    }
  });

  it("goal_submit scripts the same-turn conversation: acknowledge, clarify, propose approaches", async () => {
    // The old return was bare JSON; the model replied "goal recorded" and the
    // approaches conversation arrived turns later as an injection that could
    // hijack an unrelated message. The tool result now drives the exchange
    // the user expects: plan or clarifying questions, immediately.
    const text = await call("goal_submit", { description: "learn what drives our numbers" });
    expect(text).toContain("Respond to the user now");
    expect(text).toContain("clarifying");
    expect(text).toContain("2-3 concrete");
    expect(text).toContain("goal_select_approach");
    expect(text).toMatch(/id: goal-/);
    // Long-horizon framing: without it the model treats the goal as a task
    // and starts executing immediately instead of aligning on an approach.
    expect(text).toContain("long-running");
    expect(text).toContain("Do not start working");
    expect(text).toContain("thinking passes");
  });

  it("goal_select_approach activates the goal and records the approach", async () => {
    const id = await submitGoal("learn me a banjo");
    await call("goal_select_approach", { id, approach: "weekly lessons" });
    const [goal] = await storedGoals();
    expect(goal.active_approach).toBe("weekly lessons");
    expect(goal.status).toBe("active");
  });

  it("goal_progress appends a progress note", async () => {
    const id = await submitGoal("learn me a banjo");
    await call("goal_select_approach", { id, approach: "weekly lessons" });
    await call("goal_progress", { id, summary: "booked first lesson", what_changed: "teacher found" });
    const [goal] = await storedGoals();
    expect(goal.progress_notes).toHaveLength(1);
    expect(goal.progress_notes[0].summary).toBe("booked first lesson");
  });

  it("goal_update changes status and rejects unknown statuses", async () => {
    const id = await submitGoal("learn me a banjo");
    await call("goal_update", { id, status: "paused" });
    expect((await storedGoals())[0].status).toBe("paused");
    const err = await call("goal_update", { id, status: "procrastinating" });
    expect(err.toLowerCase()).toContain("status");
    expect((await storedGoals())[0].status).toBe("paused");
  });

  it("goal_blocker records a blocker", async () => {
    const id = await submitGoal("learn me a banjo");
    await call("goal_blocker", { id, description: "no banjo", waiting_on: "delivery" });
    expect((await storedGoals())[0].blockers[0].waiting_on).toBe("delivery");
  });

  it("lifecycle tools report an error for an unknown goal id", async () => {
    const out = await call("goal_select_approach", { id: "nope", approach: "x" });
    expect(out.toLowerCase()).toContain("no goal");
  });
});

describe("goal_submit validation", () => {
  it("rejects a missing or empty description without creating a goal", async () => {
    const out1 = await call("goal_submit", {});
    const out2 = await call("goal_submit", { description: "   " });
    expect(out1.toLowerCase()).toContain("description");
    expect(out2.toLowerCase()).toContain("description");
    await expect(readFile(join(dir, "goals", "goals.json"), "utf-8")).rejects.toThrow();
  });
});

describe("decomposition prompt", () => {
  it("no longer injects on submit — the tool result scripts the same-turn exchange", async () => {
    await submitGoal("learn me a banjo");
    expect(api.injections).toHaveLength(0);
  });

  it("still carries the goal id and selection instruction for check_goals nudges", async () => {
    const { buildDecompositionPrompt } = await import("./delivery.js");
    const prompt = buildDecompositionPrompt("learn me a banjo", "goal-123");
    expect(prompt).toContain("goal-123");
    expect(prompt).toContain("goal_select_approach");
  });
});

describe("goal_set_metric", () => {
  it("attaches a KR that the weekly status will compute from", async () => {
    const id = await submitGoal("reduce churn");
    await call("goal_set_metric", { id, name: "SMB churn rate", target: 2.5, unit: "%", query_hint: "PostHog churn insight" });
    const [goal] = await storedGoals();
    expect(goal.metric.name).toBe("SMB churn rate");
    expect(goal.metric.target).toBe(2.5);
  });

  it("validates its params", async () => {
    const out = await call("goal_set_metric", { id: "x", name: "y" });
    expect(out).toContain("numeric target");
  });
});

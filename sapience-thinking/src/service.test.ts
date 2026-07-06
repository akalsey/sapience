import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import service from "./service.js";

let dir: string;
let api: ReturnType<typeof makeApi>;

function makeApi() {
  const tools = new Map<string, any>();
  return {
    tools,
    pluginConfig: {},
    config: {},
    runtime: {
      agent: { resolveAgentWorkspaceDir: () => dir },
      state: { resolveStateDir: () => join(dir, "state") },
    },
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
  };
}

async function call(name: string, params: unknown): Promise<string> {
  const tool = api.tools.get(name);
  expect(tool, `tool ${name} should be registered`).toBeDefined();
  const result = await tool.execute("id", params);
  return result.content[0].text as string;
}

const pendingOutcome = (id: string) => ({
  [id]: { proposal_id: id, proposal_type: "action", pass_id: "pass-1", created_at: new Date().toISOString(), state: "pending" },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thinking-service-"));
  api = makeApi();
  service.register(api as any);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("record_outcome", () => {
  // The learning loop ran on vacuum: every proposal stayed pending until it
  // expired, because nothing could ever resolve one. Delivered tier prompts
  // now instruct the agent to call this with the user's reaction.
  it("resolves a pending proposal and bumps calibration confidence on acted_on", async () => {
    await mkdir(join(dir, "proactive-thinking"), { recursive: true });
    await mkdir(join(dir, "sapience"), { recursive: true });
    await writeFile(join(dir, "proactive-thinking", "outcomes.json"), JSON.stringify(pendingOutcome("p1")));
    await writeFile(join(dir, "sapience", "calibration.json"), JSON.stringify([
      { domain: "github", action_class: "github/action", tier: "propose", confidence: 0.5, confirmed_count: 0, corrected_count: 0, last_calibrated: "2026-01-01T00:00:00Z", notes: "" },
    ]));

    const out = await call("record_outcome", { proposal_id: "p1", outcome: "acted_on", domain: "github", action_class: "github/action" });
    expect(out).toContain("acted_on");

    const outcomes = JSON.parse(await readFile(join(dir, "proactive-thinking", "outcomes.json"), "utf-8"));
    expect(outcomes.p1.state).toBe("acted_on");
    expect(outcomes.p1.resolved_at).toBeDefined();

    const profile = JSON.parse(await readFile(join(dir, "sapience", "calibration.json"), "utf-8"));
    expect(profile[0].confidence).toBeCloseTo(0.6);
    expect(profile[0].confirmed_count).toBe(1);

    const events = (await readFile(join(dir, "sapience", "events.jsonl"), "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "outcome_recorded" && e.outcome === "acted_on")).toBe(true);
  });

  it("lowers confidence on rejected and leaves it alone on acknowledged", async () => {
    await mkdir(join(dir, "proactive-thinking"), { recursive: true });
    await mkdir(join(dir, "sapience"), { recursive: true });
    await writeFile(join(dir, "proactive-thinking", "outcomes.json"), JSON.stringify({ ...pendingOutcome("p1"), ...pendingOutcome("p2") }));
    await writeFile(join(dir, "sapience", "calibration.json"), JSON.stringify([
      { domain: "github", action_class: "github/action", tier: "propose", confidence: 0.5, confirmed_count: 0, corrected_count: 0, last_calibrated: "2026-01-01T00:00:00Z", notes: "" },
    ]));

    await call("record_outcome", { proposal_id: "p1", outcome: "rejected", domain: "github", action_class: "github/action" });
    let profile = JSON.parse(await readFile(join(dir, "sapience", "calibration.json"), "utf-8"));
    expect(profile[0].confidence).toBeCloseTo(0.4);
    expect(profile[0].corrected_count).toBe(1);

    await call("record_outcome", { proposal_id: "p2", outcome: "acknowledged", domain: "github", action_class: "github/action" });
    profile = JSON.parse(await readFile(join(dir, "sapience", "calibration.json"), "utf-8"));
    expect(profile[0].confidence).toBeCloseTo(0.4);
  });

  it("records the outcome even without domain info (calibration skipped)", async () => {
    await mkdir(join(dir, "proactive-thinking"), { recursive: true });
    await writeFile(join(dir, "proactive-thinking", "outcomes.json"), JSON.stringify(pendingOutcome("p1")));
    const out = await call("record_outcome", { proposal_id: "p1", outcome: "acted_on" });
    expect(out).toContain("acted_on");
    const outcomes = JSON.parse(await readFile(join(dir, "proactive-thinking", "outcomes.json"), "utf-8"));
    expect(outcomes.p1.state).toBe("acted_on");
  });

  it("reports an unknown proposal id without crashing", async () => {
    const out = await call("record_outcome", { proposal_id: "nope", outcome: "acted_on" });
    expect(out.toLowerCase()).toContain("no pending proposal");
  });

  it("rejects an invalid outcome value", async () => {
    const out = await call("record_outcome", { proposal_id: "p1", outcome: "meh" });
    expect(out.toLowerCase()).toContain("outcome");
  });
});

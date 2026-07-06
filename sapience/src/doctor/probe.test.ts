import { describe, it, expect } from "vitest";
import { runThinkingProbe, type ProbeEffects } from "./probe.js";

const artifact = {
  pluginId: "sapience-thinking",
  version: "0.3.0",
  agentId: "main",
  resolvedWorkspaceDir: "/ws",
  outputPaths: { logPath: "/ws/proactive-thinking/log.md", proposalsPath: "/ws/proactive-thinking/proposals.jsonl" },
  initAt: new Date().toISOString(),
};

function makeEffects(overrides: Partial<ProbeEffects> = {}): ProbeEffects {
  let ran = false;
  return {
    listCronJobs: async () => [{ id: "job-1", name: "sapience-thinking", enabled: true }],
    runCronJob: async () => { ran = true; return { ok: true }; },
    // mtime advances after the run — the tool handlers actually wrote.
    statMtime: async () => (ran ? 2000 : 1000),
    readArtifacts: async () => ({ "sapience-thinking": artifact as any }),
    ...overrides,
  };
}

describe("runThinkingProbe", () => {
  it("passes when the run advances the output files", async () => {
    const result = await runThinkingProbe(makeEffects(), { withinHours: true });
    expect(result.verdict).toBe("pass");
  });

  // The production outage signature: cron reports ok, no file ever written.
  it("fails when the run completes but nothing was written (within hours)", async () => {
    const result = await runThinkingProbe(makeEffects({ statMtime: async () => 1000 }), { withinHours: true });
    expect(result.verdict).toBe("fail");
    expect(result.message.toLowerCase()).toContain("never executed");
  });

  it("is inconclusive outside active hours (skips write nothing)", async () => {
    const result = await runThinkingProbe(makeEffects({ statMtime: async () => 1000 }), { withinHours: false });
    expect(result.verdict).toBe("inconclusive");
  });

  it("is blocked when the cron job is missing", async () => {
    const result = await runThinkingProbe(makeEffects({ listCronJobs: async () => [] }), { withinHours: true });
    expect(result.verdict).toBe("blocked");
    expect(result.message).toContain("cron");
  });

  it("is blocked when the plugin never initialized (no artifact)", async () => {
    const result = await runThinkingProbe(makeEffects({ readArtifacts: async () => ({}) }), { withinHours: true });
    expect(result.verdict).toBe("blocked");
  });

  it("fails when the cron run itself errors", async () => {
    const result = await runThinkingProbe(
      makeEffects({ runCronJob: async () => ({ ok: false, error: "gateway unreachable" }) }),
      { withinHours: true }
    );
    expect(result.verdict).toBe("fail");
    expect(result.detail).toContain("gateway unreachable");
  });

  it("treats a missing file that appears after the run as a write", async () => {
    let ran = false;
    const effects = makeEffects({
      runCronJob: async () => { ran = true; return { ok: true }; },
      statMtime: async () => (ran ? 5000 : null),
    });
    const result = await runThinkingProbe(effects, { withinHours: true });
    expect(result.verdict).toBe("pass");
  });
});

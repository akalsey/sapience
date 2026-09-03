import { describe, it, expect } from "vitest";
import { goalToolCollision } from "./sources.js";
import { buildSuiteDoctorReport } from "./report.js";
import { planFixes, applyFixes, patchConfigForAppliedFixes } from "./fix.js";

// Covers the seam the unit tests miss: detection -> planned fix -> applied write
// -> re-report. The bug this guards against is a fix that reads clean in isolation
// but clobbers unrelated tools.deny entries when applied to a real config.
describe("goal collision fix, end to end", () => {
  it("detects, plans, applies and then reports clean", async () => {
    // Production-shaped config: coding profile, group:plugins granted, browser denied.
    const config: any = {
      tools: { profile: "coding", alsoAllow: ["group:plugins"], deny: ["browser"] },
      plugins: { entries: { "sapience-goals": {} } },
    };
    const inputs: any = {
      nowMs: Date.now(), plugins: [], crons: [], cronListing: { available: true },
      modelAllowlist: [], pluginToolsAllowedGlobally: true, versions: [], corruptFiles: [],
      pendingProposals: { count: 0 }, workspace: { resolved: "/ws", source: "resolver" },
      files: [], memory: { wikiInstalled: true },
      host: { version: "2026.8.1" }, legacyCronJobs: [], foreignJobsWithSuiteTools: [],
      goalToolCollision: goalToolCollision(config),
    };
    const report = buildSuiteDoctorReport(inputs);
    const actions = planFixes(report).filter((a) => a.finding?.id === "tools:goal-collision");
    expect(actions).toHaveLength(1);

    const writes: Array<[string, unknown]> = [];
    await applyFixes(actions, {
      setConfig: async (p, v) => { writes.push([p, v]); },
      registerCron: async () => {}, deleteCron: async () => {}, updatePlugin: async () => {},
    });
    expect(writes).toEqual([["tools.deny", ["browser", "create_goal", "get_goal", "update_goal"]]]);
    // Exactly what the CLI hands to `openclaw config set ... --strict-json`.
    expect(JSON.stringify(writes[0]![1])).toBe('["browser","create_goal","get_goal","update_goal"]');

    // Re-report after the in-memory mirror: collision resolved, browser intact.
    patchConfigForAppliedFixes(config, actions);
    expect(config.tools.deny).toContain("browser");
    const after = buildSuiteDoctorReport({ ...inputs, goalToolCollision: goalToolCollision(config) });
    const f = after.sections.flatMap((s) => s.findings).find((f) => f.id === "tools:goal-collision");
    expect(f?.severity).toBe("ok");
  });
});

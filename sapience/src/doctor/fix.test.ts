import { describe, it, expect } from "vitest";
import { planFixes, applyFixes, type FixEffectors } from "./fix.js";
import type { DoctorReport } from "./types.js";

const report: DoctorReport = {
  sections: [
    { title: "CRONS", findings: [
      { id: "cron:sapience-routing", severity: "error", message: "not registered",
        fix: { autofixable: true, kind: "cron-register", description: "register cron sapience-routing", payload: { base: "sapience-routing" } } },
      { id: "cron:sapience-thinking", severity: "error", message: "pins bad model",
        detail: "no fix offered" }, // no fix => not actionable
    ] },
    { title: "MEMORY", findings: [
      { id: "memory:bridgeEnabled", severity: "warn", message: "bridge off",
        fix: { autofixable: true, kind: "config-set", description: "set bridge", payload: { path: "plugins.memory-wiki.bridge.enabled", value: true } } },
      { id: "memory:wiki", severity: "warn", message: "not installed",
        fix: { autofixable: false, kind: "config-set", description: "install memory-wiki" } }, // not autofixable
    ] },
  ],
  summary: { ok: 0, warn: 2, error: 2 },
  exitCode: 1,
};

describe("planFixes", () => {
  it("selects only autofixable findings that carry a payload", () => {
    const plan = planFixes(report);
    expect(plan.map((a) => a.finding.id)).toEqual(["cron:sapience-routing", "memory:bridgeEnabled"]);
  });
});

describe("applyFixes", () => {
  it("invokes the matching effector per action and reports what changed", async () => {
    const calls: string[] = [];
    const eff: FixEffectors = {
      async setConfig(path, value) { calls.push(`config ${path}=${String(value)}`); },
      async registerCron(base) { calls.push(`cron ${base}`); },
    };
    const done = await applyFixes(planFixes(report), eff);
    expect(calls).toEqual(["cron sapience-routing", "config plugins.memory-wiki.bridge.enabled=true"]);
    expect(done).toEqual(["registered cron sapience-routing", "set plugins.memory-wiki.bridge.enabled = true"]);
  });
});

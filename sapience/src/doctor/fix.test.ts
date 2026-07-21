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
    { title: "VERSIONS", findings: [
      { id: "version:sapience-thinking", severity: "warn", message: "v0.4.0 installed, v0.4.1 published",
        fix: { autofixable: true, kind: "plugin-update", description: "update sapience-thinking to v0.4.1", payload: { pluginId: "sapience-thinking" } } },
    ] },
  ],
  summary: { ok: 0, warn: 3, error: 2 },
  exitCode: 1,
};

describe("planFixes", () => {
  it("selects only autofixable findings that carry a payload", () => {
    const plan = planFixes(report);
    expect(plan.map((a) => a.finding.id)).toEqual(["cron:sapience-routing", "memory:bridgeEnabled", "version:sapience-thinking"]);
  });
});

describe("applyFixes", () => {
  it("invokes the matching effector per action and reports what changed", async () => {
    const calls: string[] = [];
    const eff: FixEffectors = {
      async setConfig(path, value) { calls.push(`config ${path}=${String(value)}`); },
      async registerCron(base) { calls.push(`cron ${base}`); },
      async updatePlugin(id) { calls.push(`update ${id}`); },
    };
    const done = await applyFixes(planFixes(report), eff);
    expect(calls).toEqual(["cron sapience-routing", "config plugins.memory-wiki.bridge.enabled=true", "update sapience-thinking"]);
    expect(done).toEqual([
      "registered cron sapience-routing",
      "set plugins.memory-wiki.bridge.enabled = true",
      "updated sapience-thinking (restart the gateway to load it)",
    ]);
  });

  it("routes suite deliveries to a session across all three delivering plugins", async () => {
    const calls: string[] = [];
    const eff: FixEffectors = {
      async setConfig(path, value) { calls.push(`${path}=${String(value)}`); },
      async registerCron() {},
      async updatePlugin() {},
    };
    const done = await applyFixes(
      [{ kind: "delivery-target-set", payload: { sessionKey: "agent:main:telegram:direct:1" } }],
      eff
    );
    expect(calls).toEqual([
      "plugins.entries.sapience.config.delivery.sessionKey=agent:main:telegram:direct:1",
      "plugins.entries.sapience-thinking.config.delivery.sessionKey=agent:main:telegram:direct:1",
      "plugins.entries.sapience-goals.config.delivery.sessionKey=agent:main:telegram:direct:1",
    ]);
    expect(done).toEqual(["routed suite deliveries to agent:main:telegram:direct:1"]);
  });
});

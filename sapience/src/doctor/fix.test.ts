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
      async deleteCron() {},
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

  it("deletes a pre-declaration-key job before registering its replacement", async () => {
    // Order matters and so does the delete: openclaw's upsert cannot match a
    // keyless job, so registering without deleting leaves the original running
    // beside the new one, still on its old delivery route.
    const calls: string[] = [];
    const eff: FixEffectors = {
      async setConfig() {},
      async registerCron(base) { calls.push(`register ${base}`); },
      async deleteCron(name) { calls.push(`delete ${name}`); },
      async updatePlugin() {},
    };
    const done = await applyFixes(
      [{ kind: "cron-register", payload: { base: "sapience-delivery", replaceName: "sapience-delivery" } }],
      eff,
    );
    expect(calls).toEqual(["delete sapience-delivery", "register sapience-delivery"]);
    expect(done).toEqual([
      "deleted pre-declaration-key cron sapience-delivery",
      "registered cron sapience-delivery",
    ]);
  });

  it("passes an existing delivery route to the registrar", async () => {
    const seen: Array<{ base: string; target?: { channel: string; to: string } }> = [];
    const eff: FixEffectors = {
      async setConfig() {},
      async registerCron(base, opts) { seen.push({ base, target: opts?.deliveryTarget }); },
      async deleteCron() {},
      async updatePlugin() {},
    };
    const done = await applyFixes([{ kind: "cron-register", payload: {
      base: "sapience-delivery", replaceName: "sapience-delivery",
      deliveryChannel: "telegram", deliveryTo: "8728003761",
    } }], eff);
    expect(seen[0]?.target).toEqual({ channel: "telegram", to: "8728003761" });
    expect(done.at(-1)).toContain("kept delivery route telegram:8728003761");
  });

  it("registers without deleting when there is no job to replace", async () => {
    const calls: string[] = [];
    const eff: FixEffectors = {
      async setConfig() {},
      async registerCron(base) { calls.push(`register ${base}`); },
      async deleteCron(name) { calls.push(`delete ${name}`); },
      async updatePlugin() {},
    };
    await applyFixes([{ kind: "cron-register", payload: { base: "sapience-delivery" } }], eff);
    expect(calls).toEqual(["register sapience-delivery"]);
  });

  it("routes suite deliveries to a session across all three delivering plugins", async () => {
    const calls: string[] = [];
    const eff: FixEffectors = {
      async setConfig(path, value) { calls.push(`${path}=${String(value)}`); },
      async registerCron() {},
      async deleteCron() {},
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

  it("patches the in-memory config so a post-fix re-report reflects applied fixes", async () => {
    const { patchConfigForAppliedFixes } = await import("./fix.js");
    const config: any = { plugins: { entries: { sapience: { enabled: true } } } };
    patchConfigForAppliedFixes(config, [
      { kind: "delivery-target-set", payload: { sessionKey: "agent:main:telegram:direct:1" } },
      { kind: "config-set", payload: { path: "plugins.entries.memory-wiki.config.bridge.enabled", value: true } },
    ]);
    expect(config.plugins.entries.sapience.config.delivery.sessionKey).toBe("agent:main:telegram:direct:1");
    expect(config.plugins.entries["sapience-thinking"].config.delivery.sessionKey).toBe("agent:main:telegram:direct:1");
    expect(config.plugins.entries["memory-wiki"].config.bridge.enabled).toBe(true);
  });
});

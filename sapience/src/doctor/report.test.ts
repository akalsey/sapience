import { describe, it, expect } from "vitest";
import { buildSuiteDoctorReport } from "./report.js";
import type { DoctorInputs, Finding } from "./types.js";

const NOW = 1_800_000_000_000;

function healthy(): DoctorInputs {
  return {
    nowMs: NOW,
    modelAllowlist: ["anthropic/claude-sonnet-4-6"],
    workspace: { resolved: "/ws", source: "artifact" },
    plugins: ["sapience-thinking", "sapience", "sapience-feedback", "sapience-goals"].map((id) => ({
      id,
      installed: true,
      artifact: {
        pluginId: id,
        version: "0.2.3",
        agentId: "main",
        resolvedWorkspaceDir: "/ws",
        outputPaths: {},
        initAt: new Date(NOW - 1000).toISOString(),
      },
    })),
    crons: ["sapience-thinking", "sapience-routing", "sapience-goals-check"].map((base) => ({
      base,
      job: { name: base, enabled: true, lastStatus: "ok", consecutiveErrors: 0 },
    })),
    files: [
      "proactive-thinking/log.md",
      "proactive-thinking/proposals.jsonl",
      "proactive-thinking/outcomes.json",
      "sapience/events.jsonl",
      "sapience/dashboard.md",
      "sapience/calibration.json",
      "sapience/action-log.md",
      "sapience/processed-passes.json",
      "goals/goals.json",
    ].map((label) => ({ label, path: `/ws/${label}`, exists: true, mtimeMs: NOW - 1000 })),
    memory: {
      wikiInstalled: true,
      dreamingEnabled: true,
      vaultMode: "bridge",
      bridgeEnabled: true,
      searchCorpus: "all",
    },
  };
}

const all = (r: { sections: { findings: Finding[] }[] }): Finding[] => r.sections.flatMap((s) => s.findings);
const byId = (r: { sections: { findings: Finding[] }[] }, id: string) => all(r).find((f) => f.id === id);

describe("buildSuiteDoctorReport", () => {
  it("reports a clean bill of health with exitCode 0", () => {
    const r = buildSuiteDoctorReport(healthy());
    expect(r.summary.error).toBe(0);
    expect(r.exitCode).toBe(0);
    expect(r.sections.map((s) => s.title)).toEqual(["PLUGINS", "CRONS", "PATHS", "MEMORY"]);
    expect(all(r).every((f) => f.severity === "ok")).toBe(true);
  });

  it("flags an uninstalled plugin as an error", () => {
    const i = healthy();
    i.plugins[2]!.installed = false;
    i.plugins[2]!.artifact = undefined;
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "plugin:sapience-feedback");
    expect(f?.severity).toBe("error");
    expect(r.exitCode).toBe(1);
  });

  it("flags an installed-but-uninitialized plugin (missing artifact) as an error", () => {
    const i = healthy();
    i.plugins[0]!.artifact = undefined;
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "plugin:sapience-thinking");
    expect(f?.severity).toBe("error");
    expect(f?.message.toLowerCase()).toContain("init");
  });

  it("warns on a stale status artifact", () => {
    const i = healthy();
    i.plugins[1]!.artifact!.initAt = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "plugin:sapience")?.severity).toBe("warn");
  });

  it("errors on a missing cron and offers a cron-register fix", () => {
    const i = healthy();
    i.crons[1]!.job = undefined;
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "cron:sapience-routing");
    expect(f?.severity).toBe("error");
    expect(f?.fix?.kind).toBe("cron-register");
    expect(f?.fix?.autofixable).toBe(true);
  });

  it("errors when a cron pins a model outside the allowlist", () => {
    const i = healthy();
    i.crons[0]!.job!.payloadModel = "anthropic/claude-haiku-4-5-20251001";
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "cron:sapience-thinking");
    expect(f?.severity).toBe("error");
    expect(f?.message.toLowerCase()).toContain("allowlist");
  });

  it("accepts a pinned model that is in the allowlist", () => {
    const i = healthy();
    i.crons[0]!.job!.payloadModel = "anthropic/claude-sonnet-4-6";
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "cron:sapience-thinking")?.severity).toBe("ok");
  });

  it("errors when a cron's last run failed", () => {
    const i = healthy();
    i.crons[2]!.job!.lastStatus = "error";
    i.crons[2]!.job!.consecutiveErrors = 5;
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "cron:sapience-goals-check")?.severity).toBe("error");
  });

  it("warns on a disabled cron", () => {
    const i = healthy();
    i.crons[0]!.job!.enabled = false;
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "cron:sapience-thinking")?.severity).toBe("warn");
  });

  it("warns and offers a config-set fix for a wrong memory setting", () => {
    const i = healthy();
    i.memory.bridgeEnabled = false;
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "memory:bridgeEnabled");
    expect(f?.severity).toBe("warn");
    expect(f?.fix?.kind).toBe("config-set");
    expect(f?.fix?.payload?.path).toBe("plugins.memory-wiki.bridge.enabled");
    expect(f?.fix?.payload?.value).toBe(true);
  });

  it("warns when memory-wiki is absent and skips wiki-only settings", () => {
    const i = healthy();
    i.memory = { wikiInstalled: false };
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "memory:wiki")?.severity).toBe("warn");
    // wiki-only settings are not asserted when the plugin is absent
    expect(byId(r, "memory:vaultMode")).toBeUndefined();
    // but dreaming (memory-core, independent) is still checked
    expect(byId(r, "memory:dreamingEnabled")).toBeDefined();
  });

  it("warns when the resolved workspace differs from the resolver-expected dir", () => {
    const i = healthy();
    i.workspace = { resolved: "/ws", source: "artifact", resolverExpected: "/other" };
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "paths:workspace")?.severity).toBe("warn");
    expect(byId(r, "paths:workspace")?.detail?.toLowerCase()).toContain("differ");
  });

  it("warns when the workspace dir is only a resolver fallback (gateway not observed)", () => {
    const i = healthy();
    i.workspace = { resolved: "/ws", source: "resolver" };
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "paths:workspace")?.severity).toBe("warn");
  });

  it("warns on a missing output file but shows its absolute path", () => {
    const i = healthy();
    i.files[3]! = { label: "sapience/events.jsonl", path: "/ws/sapience/events.jsonl", exists: false };
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "file:sapience/events.jsonl");
    expect(f?.severity).toBe("warn");
    expect(f?.detail).toContain("/ws/sapience/events.jsonl");
  });
});

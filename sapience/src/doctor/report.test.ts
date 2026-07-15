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
    crons: [
      { base: "sapience-thinking", job: { name: "sapience-thinking", enabled: true, lastStatus: "ok", consecutiveErrors: 0, toolsAllow: ["get_thinking_context", "record_thinking_output"] } },
      { base: "sapience-routing", job: { name: "sapience-routing", enabled: true, lastStatus: "ok", consecutiveErrors: 0, toolsAllow: ["process_proposals"] } },
      { base: "sapience-goals-check", job: { name: "sapience-goals-check", enabled: true, lastStatus: "ok", consecutiveErrors: 0, toolsAllow: ["check_goals"] } },
    ],
    pluginToolsAllowedGlobally: false,
    cronListing: { available: true },
    versions: [],
    corruptFiles: [],
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

  it("warns on a stale status artifact (no liveness heartbeat)", () => {
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
    // Must be the REAL config path shape — `openclaw config set` takes
    // plugins.entries.<id>.config.<key>; the short form is rejected.
    expect(f?.fix?.payload?.path).toBe("plugins.entries.memory-wiki.config.bridge.enabled");
    expect(f?.fix?.payload?.value).toBe(true);
    expect(f?.fix?.description).toContain("plugins.entries.memory-wiki.config.bridge.enabled");
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

  it("warns when the workspace dir is only a resolver fallback (gateway not observed)", () => {
    const i = healthy();
    i.workspace = { resolved: "/ws", source: "resolver" };
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "paths:workspace")?.severity).toBe("warn");
  });

  it("errors when a cron has no tools grant and plugin tools are not globally allowed", () => {
    const i = healthy();
    i.crons[1]!.job!.toolsAllow = undefined;
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "cron:sapience-routing");
    expect(f?.severity).toBe("error");
    expect(f?.message.toLowerCase()).toContain("tool");
    expect(r.exitCode).toBe(1);
  });

  it("accepts a cron without a tools grant when plugin tools are globally allowed", () => {
    const i = healthy();
    i.crons[1]!.job!.toolsAllow = undefined;
    i.pluginToolsAllowedGlobally = true;
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "cron:sapience-routing")?.severity).toBe("ok");
  });

  it("errors when an empty toolsAllow list has no global fallback", () => {
    const i = healthy();
    i.crons[0]!.job!.toolsAllow = [];
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "cron:sapience-thinking")?.severity).toBe("error");
  });

  it("errors when all crons run green but no output file exists (tools not reaching sessions)", () => {
    const i = healthy();
    i.files = i.files.map((f) => ({ label: f.label, path: f.path, exists: false }));
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "paths:no-output");
    expect(f?.severity).toBe("error");
    expect(f?.message.toLowerCase()).toContain("no output");
    expect(r.exitCode).toBe(1);
  });

  it("does not raise the no-output contradiction when a cron is missing (absence is explained)", () => {
    const i = healthy();
    i.files = i.files.map((f) => ({ label: f.label, path: f.path, exists: false }));
    i.crons[1]!.job = undefined;
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "paths:no-output")).toBeUndefined();
  });

  it("does not raise the no-output contradiction when any output file exists", () => {
    const i = healthy();
    i.files = i.files.map((f, idx) => (idx === 0 ? f : { label: f.label, path: f.path, exists: false }));
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "paths:no-output")).toBeUndefined();
  });

  // The production incident: `openclaw cron list --json` failed in the
  // doctor's child process (dockerized gateway unreachable from the exec
  // context), the catch swallowed it into [], and the doctor asserted all
  // three crons "not registered" — offering --fix actions that would have
  // minted duplicate jobs. Observation failure must never read as absence.
  it("reports a single listing-failure error (with the exec error) when crons cannot be observed", () => {
    const i = healthy();
    i.crons = [];
    i.cronListing = { available: false, error: "GatewayCredentialsRequiredError: gateway cron.list requires credentials" };
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "cron:listing");
    expect(f?.severity).toBe("error");
    expect(f?.message.toLowerCase()).toContain("could not list");
    expect(f?.detail).toContain("GatewayCredentialsRequiredError");
    expect(f?.fix).toBeUndefined();
    // No per-cron "not registered" assertions, no autofix bait.
    expect(byId(r, "cron:sapience-thinking")).toBeUndefined();
    expect(all(r).every((x) => x.fix?.kind !== "cron-register")).toBe(true);
  });

  it("does not raise the no-output contradiction or staleness when the listing failed", () => {
    const i = healthy();
    i.crons = [];
    i.cronListing = { available: false, error: "boom" };
    i.files = i.files.map((f) => ({ label: f.label, path: f.path, exists: false }));
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "paths:no-output")).toBeUndefined();
  });

  it("includes the job id in the failed-run inspect advice", () => {
    const i = healthy();
    i.crons[0]!.job!.id = "40128baf-be90-4a17-8d44-0153bce8c4a1";
    i.crons[0]!.job!.lastStatus = "error";
    i.crons[0]!.job!.consecutiveErrors = 2;
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "cron:sapience-thinking");
    expect(f?.severity).toBe("error");
    expect(f?.detail).toContain("openclaw cron get 40128baf-be90-4a17-8d44-0153bce8c4a1");
  });

  it("warns about legacy duplicate cron jobs that can shadow the real one", () => {
    const i = healthy();
    i.crons[0]!.extraMatches = ["sapience-thinking-pass"];
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "cron:sapience-thinking");
    expect(f?.severity).toBe("warn");
    expect(f?.message).toContain("sapience-thinking-pass");
  });

  it("errors when a cron's tools grant does not cover the tools its prompt calls", () => {
    const i = healthy();
    i.crons[0]!.job!.toolsAllow = ["get_thinking_context"]; // missing record_thinking_output
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "cron:sapience-thinking");
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("record_thinking_output");
  });

  it("errors when a pipeline file exists but is stale while all crons are green", () => {
    const i = healthy();
    const DAY = 24 * 60 * 60 * 1000;
    i.files[1] = { label: "proactive-thinking/proposals.jsonl", path: "/ws/proactive-thinking/proposals.jsonl", exists: true, mtimeMs: NOW - 3 * DAY, staleAfterMs: DAY };
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "file:proactive-thinking/proposals.jsonl");
    expect(f?.severity).toBe("error");
    expect(f?.message.toLowerCase()).toContain("stale");
  });

  it("does not raise staleness when a cron is already failing (the cron error explains it)", () => {
    const i = healthy();
    const DAY = 24 * 60 * 60 * 1000;
    i.files[1] = { label: "proactive-thinking/proposals.jsonl", path: "/ws/p.jsonl", exists: true, mtimeMs: NOW - 3 * DAY, staleAfterMs: DAY };
    i.crons[0]!.job!.lastStatus = "error";
    i.crons[0]!.job!.consecutiveErrors = 3;
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "file:proactive-thinking/proposals.jsonl")?.severity).toBe("ok");
  });

  it("warns when feedback capture is degraded to command-only", () => {
    const i = healthy();
    const feedback = i.plugins.find((p) => p.id === "sapience-feedback")!;
    feedback.artifact!.captureMode = "command-only";
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "plugin:sapience-feedback");
    expect(f?.severity).toBe("warn");
    expect(f?.message).toContain("command-only");
  });

  it("errors when the on-disk package is newer than what the gateway is running (restart needed)", () => {
    const i = healthy();
    i.versions = [{ pluginId: "sapience", running: "0.2.6", onDisk: "0.2.7" }];
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "version:sapience");
    expect(f?.severity).toBe("error");
    expect(f?.message.toLowerCase()).toContain("restart");
  });

  it("warns when the registry has a newer version, offering an autofixable update", () => {
    const i = healthy();
    i.versions = [{ pluginId: "sapience", running: "0.2.7", onDisk: "0.2.7", registryLatest: "0.3.0" }];
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "version:sapience");
    expect(f?.severity).toBe("warn");
    expect(f?.message).toContain("0.3.0");
    expect(f?.detail).toContain("openclaw plugins update sapience");
    expect(f?.fix?.autofixable).toBe(true);
    expect(f?.fix?.kind).toBe("plugin-update");
    expect(f?.fix?.payload?.pluginId).toBe("sapience");
  });

  it("warns about a stale legacy pin in the top-level npm package.json", () => {
    const i = healthy();
    i.versions = [{ pluginId: "sapience", running: "0.2.7", onDisk: "0.2.7", legacyRootPin: "0.1.3" }];
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "version:sapience");
    expect(f?.severity).toBe("warn");
    expect(f?.message.toLowerCase()).toContain("legacy");
  });

  it("reports matching versions as ok", () => {
    const i = healthy();
    i.versions = [{ pluginId: "sapience", running: "0.2.7", onDisk: "0.2.7", registryLatest: "0.2.7" }];
    const r = buildSuiteDoctorReport(i);
    expect(byId(r, "version:sapience")?.severity).toBe("ok");
  });

  it("warns about quarantined corrupt state files", () => {
    const i = healthy();
    i.corruptFiles = ["/ws/goals/goals.json.corrupt-2026-07-01T00-00-00Z"];
    const r = buildSuiteDoctorReport(i);
    const f = byId(r, "paths:corrupt-files");
    expect(f?.severity).toBe("warn");
    expect(f?.detail).toContain("goals.json.corrupt");
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

import type {
  DoctorInputs,
  DoctorReport,
  Finding,
  Section,
  CronObservation,
  PluginObservation,
} from "./types.js";
import { MEMORY_SETTINGS, ARTIFACT_STALE_MS } from "./inventory.js";

function ageStr(nowMs: number, mtimeMs?: number): string {
  if (mtimeMs === undefined) return "unknown";
  const s = Math.max(0, Math.round((nowMs - mtimeMs) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function pluginFinding(p: PluginObservation, nowMs: number): Finding {
  const id = `plugin:${p.id}`;
  if (!p.installed) {
    return { id, severity: "error", source: "config", message: `${p.id} is not installed`,
      detail: "Install it (see install.sh) — the suite needs all four plugins." };
  }
  if (!p.artifact) {
    return { id, severity: "error", source: "artifact",
      message: `${p.id} is installed but did not initialize`,
      detail: "No status artifact written — register() likely bailed. Check `openclaw doctor` / gateway logs." };
  }
  const initMs = Date.parse(p.artifact.initAt);
  if (nowMs - initMs > ARTIFACT_STALE_MS) {
    return { id, severity: "warn", source: "artifact",
      message: `${p.id} v${p.artifact.version} — status artifact is stale (${ageStr(nowMs, initMs)})`,
      detail: "The gateway may not have reloaded this plugin recently." };
  }
  return { id, severity: "ok", source: "artifact", message: `${p.id} v${p.artifact.version} initialized` };
}

function cronFinding(c: CronObservation, allowlist: string[], pluginToolsGlobal: boolean): Finding {
  const id = `cron:${c.base}`;
  if (!c.job) {
    return { id, severity: "error", source: "cron", message: `cron ${c.base} is not registered`,
      detail: "Re-run install.sh to register it.",
      fix: { autofixable: true, kind: "cron-register", description: `register cron ${c.base}`, payload: { base: c.base } } };
  }
  const j = c.job;
  if (j.payloadModel && !allowlist.includes(j.payloadModel)) {
    return { id, severity: "error", source: "cron",
      message: `cron ${j.name} pins model '${j.payloadModel}' not in the agents.defaults.models allowlist`,
      detail: "Cron preflight rejects every run. Clear the pinned model (let it inherit the agent default) or re-run install.sh." };
  }
  if (j.lastStatus === "error" || (j.consecutiveErrors ?? 0) > 0) {
    return { id, severity: "error", source: "cron",
      message: `cron ${j.name} last run failed (${j.consecutiveErrors ?? 0} consecutive errors)`,
      detail: "Inspect with `openclaw cron get`." };
  }
  if (!pluginToolsGlobal && !j.toolsAllow?.length) {
    return { id, severity: "error", source: "cron",
      message: `cron ${j.name} has no plugin-tool grant — its session cannot call the suite's tools`,
      detail: "The run reports ok while the agent can't see the tool (and may improvise with whatever is available). Delete the job and re-register it with --tools (re-run install.sh or `openclaw sapience doctor --fix` after deleting), or set tools.alsoAllow to include group:plugins." };
  }
  if (!j.enabled) {
    return { id, severity: "warn", source: "cron", message: `cron ${j.name} is disabled` };
  }
  return { id, severity: "ok", source: "cron", message: `cron ${j.name} ok` };
}

// Every cron reports green yet not one output file exists — the runs complete
// without the tool handlers ever executing. This is the signature of plugin
// tools not reaching the cron sessions, whatever the cause.
function noOutputContradiction(i: DoctorInputs): Finding | undefined {
  const cronsAllGreen = i.crons.length > 0 &&
    i.crons.every((c) => c.job && c.job.enabled && c.job.lastStatus === "ok");
  const nothingWritten = i.files.length > 0 && i.files.every((f) => !f.exists);
  if (!cronsAllGreen || !nothingWritten) return undefined;
  return { id: "paths:no-output", severity: "error", source: "fs",
    message: "crons run green but no output files exist — the plugin tools are never executing",
    detail: "The cron agents likely can't see the suite's tools. Check each job's payload.toolsAllow and the tools.profile/alsoAllow config (see the CRONS section)." };
}

function pathsSection(i: DoctorInputs): Section {
  const findings: Finding[] = [];
  const w = i.workspace;
  if (w.source === "resolver") {
    findings.push({ id: "paths:workspace", severity: "warn", source: "resolver",
      message: `workspace dir: ${w.resolved}`,
      detail: "expected dir (gateway not observed — no status artifact). Run in the same profile/--dev context as the gateway." });
  } else {
    findings.push({ id: "paths:workspace", severity: "ok", source: "artifact", message: `workspace dir: ${w.resolved}` });
  }

  const contradiction = noOutputContradiction(i);
  if (contradiction) findings.push(contradiction);

  for (const f of i.files) {
    if (f.exists) {
      findings.push({ id: `file:${f.label}`, severity: "ok", source: "fs",
        message: `${f.label} (found, ${ageStr(i.nowMs, f.mtimeMs)})` });
    } else {
      findings.push({ id: `file:${f.label}`, severity: "warn", source: "fs",
        message: `${f.label} not found`,
        detail: `${f.path} — may be normal if there has been no activity yet.` });
    }
  }
  return { title: "PATHS", findings };
}

function memorySection(i: DoctorInputs): Section {
  const findings: Finding[] = [];
  const m = i.memory;
  if (!m.wikiInstalled) {
    findings.push({ id: "memory:wiki", severity: "warn", source: "config",
      message: "memory-wiki is not installed",
      detail: "Without it, feedback corrections and thinking context will not resurface across sessions. Install via install.sh.",
      fix: { autofixable: false, kind: "config-set", description: "install memory-wiki" } });
  } else {
    findings.push({ id: "memory:wiki", severity: "ok", source: "config", message: "memory-wiki installed" });
  }

  for (const s of MEMORY_SETTINGS) {
    const isWikiOnly = s.path.startsWith("plugins.memory-wiki");
    if (isWikiOnly && !m.wikiInstalled) continue; // moot without the plugin
    const actual = m[s.key];
    const id = `memory:${s.key}`;
    if (actual === s.expected) {
      findings.push({ id, severity: "ok", source: "config", message: `${s.label} = ${String(s.expected)}` });
    } else {
      findings.push({ id, severity: "warn", source: "config",
        message: `${s.label} is ${actual === undefined ? "unset" : String(actual)}, expected ${String(s.expected)}`,
        fix: { autofixable: true, kind: "config-set", description: `set ${s.path} = ${String(s.expected)}`,
          payload: { path: s.path, value: s.expected } } });
    }
  }
  return { title: "MEMORY", findings };
}

export function buildSuiteDoctorReport(i: DoctorInputs): DoctorReport {
  const sections: Section[] = [
    { title: "PLUGINS", findings: i.plugins.map((p) => pluginFinding(p, i.nowMs)) },
    { title: "CRONS", findings: i.crons.map((c) => cronFinding(c, i.modelAllowlist, i.pluginToolsAllowedGlobally)) },
    pathsSection(i),
    memorySection(i),
  ];

  const summary = { ok: 0, warn: 0, error: 0 };
  for (const s of sections) for (const f of s.findings) summary[f.severity]++;

  return { sections, summary, exitCode: summary.error > 0 ? 1 : 0 };
}

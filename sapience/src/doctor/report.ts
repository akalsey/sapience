import type {
  DoctorInputs,
  DoctorReport,
  Finding,
  Section,
  CronObservation,
  PluginObservation,
  VersionObservation,
} from "./types.js";
import { MEMORY_SETTINGS, ARTIFACT_STALE_MS, SUITE_CRONS } from "./inventory.js";

function durationStr(nowMs: number, thenMs: number): string {
  return ageStr(nowMs, thenMs).replace(/ ago$/, "");
}

function ageStr(nowMs: number, mtimeMs?: number): string {
  if (mtimeMs === undefined) return "unknown";
  const s = Math.max(0, Math.round((nowMs - mtimeMs) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function pluginFinding(
  p: PluginObservation,
  nowMs: number,
  ctx: { siblingAlive: boolean; onDisk?: string }
): Finding {
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
  if (p.artifact.initError) {
    return { id, severity: "error", source: "artifact",
      message: `${p.id} register() failed in the gateway`,
      detail: `${p.artifact.initError} (recorded ${ageStr(nowMs, Date.parse(p.artifact.initAt))})` };
  }
  const initMs = Date.parse(p.artifact.initAt);
  if (nowMs - initMs > ARTIFACT_STALE_MS) {
    const versionNote = ctx.onDisk && (p.artifact.version === "unknown" || p.artifact.version !== ctx.onDisk)
      ? ` (v${ctx.onDisk} on disk has never initialized; the artifact is from ${p.artifact.version === "unknown" ? "an older build" : `v${p.artifact.version}`})`
      : "";
    if (ctx.siblingAlive) {
      // Other suite plugins are heartbeating, so the gateway is up and loading
      // plugins — this one specifically is not initializing.
      return { id, severity: "error", source: "artifact",
        message: `${p.id} has not initialized in ${durationStr(nowMs, initMs)} while other suite plugins are alive${versionNote}`,
        detail: "The gateway is not loading this plugin. Check startup logs (e.g. `docker compose logs openclaw | grep -i " + p.id + "`) and `openclaw plugins inspect " + p.id + "`." };
    }
    return { id, severity: "warn", source: "artifact",
      message: `${p.id} v${p.artifact.version} — no liveness signal in ${durationStr(nowMs, initMs)}${versionNote}`,
      detail: "Plugins refresh their status artifact on every cron run. All suite artifacts are quiet — the gateway may simply be stopped, or the plugins predate the heartbeat (update them)." };
  }
  if (p.artifact.captureMode === "command-only") {
    return { id, severity: "warn", source: "artifact",
      message: `${p.id} v${p.artifact.version} — passive capture degraded to command-only`,
      detail: "The gateway did not expose the message-hook surface; only /feedback works. Check the gateway version." };
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
      detail: `Inspect with \`openclaw cron get ${j.id ?? "<job-id from cron list>"}\` (it takes the job id, not the name).` };
  }
  if (!pluginToolsGlobal && !j.toolsAllow?.length) {
    return { id, severity: "error", source: "cron",
      message: `cron ${j.name} has no plugin-tool grant — its session cannot call the suite's tools`,
      detail: "The run reports ok while the agent can't see the tool (and may improvise with whatever is available). Delete the job and re-register it with --tools (re-run install.sh or `openclaw sapience doctor --fix` after deleting), or set tools.alsoAllow to include group:plugins." };
  }
  // A grant that exists but misses a tool the prompt calls fails just as
  // silently as no grant at all.
  if (!pluginToolsGlobal && j.toolsAllow?.length) {
    const expectedTools = SUITE_CRONS.find((sc) => j.name === sc.base || j.name.startsWith(`${sc.base}-`))?.tools ?? [];
    const missing = expectedTools.filter((t) => !j.toolsAllow!.includes(t));
    if (missing.length > 0) {
      return { id, severity: "error", source: "cron",
        message: `cron ${j.name} tools grant is missing ${missing.join(", ")}`,
        detail: "The prompt instructs the agent to call tools the session can't see. Re-register with the full --tools list (see install.sh)." };
    }
  }
  if (!j.enabled) {
    return { id, severity: "warn", source: "cron", message: `cron ${j.name} is disabled` };
  }
  if (c.extraMatches?.length) {
    return { id, severity: "warn", source: "cron",
      message: `cron ${j.name} ok, but legacy duplicate job(s) exist: ${c.extraMatches.join(", ")}`,
      detail: "Old jobs from a previous installer can shadow the real one in ad-hoc checks. Delete them with `openclaw cron delete`." };
  }
  return { id, severity: "ok", source: "cron", message: `cron ${j.name} ok` };
}

function allCronsGreen(i: DoctorInputs): boolean {
  return i.crons.length > 0 &&
    i.crons.every((c) => c.job && c.job.enabled && c.job.lastStatus === "ok");
}

// Every cron reports green yet not one output file exists — the runs complete
// without the tool handlers ever executing. This is the signature of plugin
// tools not reaching the cron sessions, whatever the cause.
function noOutputContradiction(i: DoctorInputs): Finding | undefined {
  const nothingWritten = i.files.length > 0 && i.files.every((f) => !f.exists);
  if (!allCronsGreen(i) || !nothingWritten) return undefined;
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

  const cronsAllGreen = allCronsGreen(i);

  for (const f of i.files) {
    if (f.exists) {
      // An existing-but-stale pipeline file under green crons is the
      // established-install signature of tools not reaching cron sessions —
      // the file class the all-missing contradiction can't catch.
      const stale = f.staleAfterMs !== undefined && f.mtimeMs !== undefined
        && i.nowMs - f.mtimeMs > f.staleAfterMs;
      if (stale && cronsAllGreen) {
        findings.push({ id: `file:${f.label}`, severity: "error", source: "fs",
          message: `${f.label} is stale (${ageStr(i.nowMs, f.mtimeMs)}) while its cron reports ok`,
          detail: `${f.path} — the cron runs but the tool handlers never write. Check tool exposure (payload.toolsAllow / tools.alsoAllow).` });
      } else {
        findings.push({ id: `file:${f.label}`, severity: "ok", source: "fs",
          message: `${f.label} (found, ${ageStr(i.nowMs, f.mtimeMs)})` });
      }
    } else {
      findings.push({ id: `file:${f.label}`, severity: "warn", source: "fs",
        message: `${f.label} not found`,
        detail: `${f.path} — may be normal if there has been no activity yet.` });
    }
  }

  if (i.corruptFiles.length > 0) {
    findings.push({ id: "paths:corrupt-files", severity: "warn", source: "fs",
      message: `${i.corruptFiles.length} quarantined state file(s) found`,
      detail: `A state file failed to parse and was reset; the original data is preserved at: ${i.corruptFiles.join(", ")}` });
  }
  return { title: "PATHS", findings };
}

// Lexicographic-numeric semver comparison, good enough for x.y.z strings.
function versionLess(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const da = pa[k] ?? 0, db = pb[k] ?? 0;
    if (da !== db) return da < db;
  }
  return false;
}

function versionFinding(v: VersionObservation): Finding {
  const id = `version:${v.pluginId}`;
  if (v.running && v.onDisk && v.running !== v.onDisk) {
    return { id, severity: "error", source: "fs",
      message: `${v.pluginId}: gateway runs v${v.running} but v${v.onDisk} is installed on disk — restart the gateway`,
      detail: "The update won't load until the gateway restarts; until then old code runs with a fresh-looking install." };
  }
  if (v.legacyRootPin) {
    return { id, severity: "warn", source: "fs",
      message: `${v.pluginId}: legacy top-level npm package.json pins v${v.legacyRootPin}`,
      detail: "The stale root install is not what the gateway loads, but it misleads debugging. Remove the entry from <state>/npm/package.json." };
  }
  const current = v.onDisk ?? v.running;
  if (current && v.registryLatest && versionLess(current, v.registryLatest)) {
    return { id, severity: "warn", source: "fs",
      message: `${v.pluginId}: v${current} installed, v${v.registryLatest} published`,
      detail: `Run \`openclaw plugins update ${v.pluginId}\` and restart the gateway — or \`openclaw sapience doctor --fix\` does the update.`,
      fix: { autofixable: true, kind: "plugin-update", description: `update ${v.pluginId} to v${v.registryLatest}`, payload: { pluginId: v.pluginId } } };
  }
  return { id, severity: "ok", source: "fs", message: `${v.pluginId} v${current ?? "unknown"} current` };
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
    const isWikiOnly = s.path.startsWith("plugins.entries.memory-wiki.");
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
  // When the listing itself failed we could not observe crons at all — one
  // honest error, no per-cron "not registered" assertions, no autofix bait.
  const cronFindings: Finding[] = i.cronListing.available
    ? i.crons.map((c) => cronFinding(c, i.modelAllowlist, i.pluginToolsAllowedGlobally))
    : [{
        id: "cron:listing", severity: "error", source: "cron",
        message: "could not list cron jobs — cron state is unverified this run",
        detail: `\`openclaw cron list --all --json\` failed: ${i.cronListing.error ?? "unknown error"}. Run the doctor where the gateway is reachable (e.g. inside the container: docker compose exec openclaw openclaw sapience doctor).`,
      }];

  const onDiskByPlugin = new Map(i.versions.map((v) => [v.pluginId, v.onDisk]));
  const freshIds = new Set(
    i.plugins
      .filter((p) => p.artifact && !p.artifact.initError && i.nowMs - Date.parse(p.artifact.initAt) <= ARTIFACT_STALE_MS)
      .map((p) => p.id)
  );

  const sections: Section[] = [
    { title: "PLUGINS", findings: i.plugins.map((p) => pluginFinding(p, i.nowMs, {
      siblingAlive: [...freshIds].some((fid) => fid !== p.id),
      onDisk: onDiskByPlugin.get(p.id),
    })) },
    { title: "CRONS", findings: cronFindings },
    pathsSection(i),
    memorySection(i),
  ];
  if (i.versions.length > 0) {
    sections.push({ title: "VERSIONS", findings: i.versions.map(versionFinding) });
  }

  const summary = { ok: 0, warn: 0, error: 0 };
  for (const s of sections) for (const f of s.findings) summary[f.severity]++;

  return { sections, summary, exitCode: summary.error > 0 ? 1 : 0 };
}

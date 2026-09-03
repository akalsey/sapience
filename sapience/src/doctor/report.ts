import type {
  DoctorInputs,
  DoctorReport,
  Finding,
  Section,
  CronObservation,
  PluginObservation,
  VersionObservation,
} from "./types.js";
import { MEMORY_SETTINGS, ARTIFACT_STALE_MS, SUITE_CRONS, SUITE_FILES, CRON_REFRESHED_PLUGINS, CORE_GOAL_TOOLS, DELIVERY_POLL_CRON_BASE, cronSpecFor } from "./inventory.js";
import { hasStrictSilenceContract, isSupportedHost, MIN_SUPPORTED_HOST_VERSION } from "./host-version.js";

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
    // onDisk absent means no version evidence contradicts the artifact; treat
    // it as matching rather than raising a spurious stale error.
    const versionMatchesDisk = !ctx.onDisk || p.artifact.version === ctx.onDisk;
    if (!CRON_REFRESHED_PLUGINS.has(p.id) && versionMatchesDisk) {
      return { id, severity: "ok", source: "artifact",
        message: `${p.id} v${p.artifact.version} initialized (artifact from register, ${ageStr(nowMs, initMs)}; no cron refreshes it)`,
        detail: `For live status: \`openclaw plugins inspect ${p.id}\`.` };
    }
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
  // A fresh artifact reporting an older version than the on-disk build means
  // the plugin was updated but the gateway never reloaded it — tools and fixes
  // from the new build silently aren't running (a delivery cron once failed
  // with "no registered tools matched" in exactly this state).
  if (ctx.onDisk && p.artifact.version !== "unknown" && p.artifact.version !== ctx.onDisk) {
    return { id, severity: "warn", source: "artifact",
      message: `${p.id} v${p.artifact.version} loaded, v${ctx.onDisk} installed`,
      detail: "The gateway is still running the old build. Restart the gateway to load the update." };
  }
  if (p.artifact.captureMode === "command-only") {
    return { id, severity: "warn", source: "artifact",
      message: `${p.id} v${p.artifact.version} — passive capture degraded to command-only`,
      detail: "The gateway did not expose the message-hook surface; only /feedback works. Check the gateway version." };
  }
  return { id, severity: "ok", source: "artifact", message: `${p.id} v${p.artifact.version} initialized` };
}

function cronFinding(
  c: CronObservation,
  allowlist: string[],
  pluginToolsGlobal: boolean,
  strictSilenceHost: boolean,
): Finding {
  const id = `cron:${c.base}`;
  if (!c.job) {
    return { id, severity: "error", source: "cron", message: `cron ${c.base} is not registered`,
      detail: "Re-run install.sh to register it.",
      fix: { autofixable: true, kind: "cron-register", description: `register cron ${c.base}`, payload: { base: c.base } } };
  }
  const j = c.job;
  const spec = cronSpecFor(c.base);

  // Checked before anything about the job's run state, because it is a
  // structural property and its fix subsumes the rest: replacing the job
  // re-registers it with the current prompt, tools, delivery route and enabled
  // state in one step. Ordering this after the enabled/disabled checks meant a
  // job that had been disabled by hand reported as healthy and was never
  // offered the fix — which is the state an operator lands in after muting a
  // noisy job themselves.
  //
  // openclaw's upsert matches on the declaration key alone, so a job registered
  // before the suite adopted keys cannot be matched and must be replaced rather
  // than updated. Registering over it leaves the original running.
  if (!j.declarationKey) {
    return { id, severity: "warn", source: "cron",
      message: `cron ${j.name} predates declaration keys and must be replaced, not updated`,
      detail: "Re-registering it without deleting it first leaves two copies running, and the old one keeps whatever delivery route it was created with. This fix deletes it and registers the current definition in its place."
        // The suite never sets a model, so a replacement drops any per-job pin.
        // Name it rather than carrying it: the choice of model is the
        // operator's, and it should be theirs to re-make knowingly.
        + (j.payloadModel
          ? ` This job pins the model ${j.payloadModel}; the replacement will not, so it reverts to the agent default. Re-pin it with \`openclaw cron edit <new-job-id> --model ${j.payloadModel}\` if you still want it.`
          : ""),
      fix: { autofixable: true, kind: "cron-register",
        description: `replace pre-declaration-key cron ${j.name}`,
        // Carry the job's own delivery route across. Unlike a model pin, this
        // is routing the suite owns and would otherwise silently downgrade to
        // announce/last — which is the noisy configuration.
        payload: { base: c.base, replaceName: j.name,
          ...(j.deliveryTo ? { deliveryTo: j.deliveryTo } : {}),
          ...(j.deliveryChannel ? { deliveryChannel: j.deliveryChannel } : {}) } } };
  }

  // A prompt naming the constant instead of its value. The runtime recognizes
  // only the literal NO_REPLY, so such a job can never complete silently.
  if (j.message?.includes("SILENT_REPLY_TOKEN")) {
    return { id, severity: "error", source: "cron",
      message: `cron ${j.name} asks the model to reply "SILENT_REPLY_TOKEN", which the runtime does not recognize`,
      detail: "The silent token is the literal string NO_REPLY. A job with this prompt cannot complete silently, and on a job with a delivery route it announces on every run. Re-register it (re-run install.sh or `openclaw sapience doctor --fix` after deleting the job)." };
  }

  // Command payloads never start an agent turn, so tool grants, model pinning
  // and bootstrap context do not apply. Checking them would report a healthy
  // poll job as broken.
  if (j.isCommandPayload) {
    if (j.lastStatus === "error" || (j.consecutiveErrors ?? 0) > 0) {
      return { id, severity: "error", source: "cron",
        message: `cron ${j.name} last run failed (${j.consecutiveErrors ?? 0} consecutive errors)`,
        detail: `Its payload is \`openclaw sapience deliver-check\`. Run that by hand to see the failure, then inspect with \`openclaw cron get ${j.id ?? "<job-id from cron list>"}\`.` };
    }
    if (!j.enabled) {
      return { id, severity: "error", source: "cron",
        message: `cron ${j.name} is disabled — queued deliveries will never be sent`,
        detail: "This job is what starts the delivery turn. With it disabled the delivery job never runs, because it has no schedule of its own." };
    }
    return { id, severity: "ok", source: "cron", message: `cron ${j.name} ok` };
  }

  // An on-demand job carrying a live announce route is the 2026.8+ hazard: any
  // run that ends without text delivers the runner's placeholder sentence.
  if (strictSilenceHost && spec?.onDemand && j.announces) {
    return { id, severity: "warn", source: "cron",
      message: `cron ${j.name} announces on a host that delivers empty-turn placeholder text`,
      detail: "On OpenClaw 2026.8+ an announce job's run is marked as requiring visible text, so a turn that ends without any is given a placeholder sentence and the route delivers it. A better model does not help — the substitution happens precisely when the model produced nothing — and no prompt wording prevents it. Pin an explicit destination (SAPIENCE_DELIVERY_CHANNEL / SAPIENCE_DELIVERY_TO) and re-run install.sh: --no-deliver plus an explicit target drops the requirement to optional while still resolving a route for the message tool, so an empty turn delivers nothing at all." };
  }
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
    // The delivery job ships disabled on purpose: sapience-poll-delivery runs
    // it only when the queue is non-empty, which is what keeps ~95% of its runs
    // (and their announcements) from happening at all.
    if (spec?.onDemand) {
      return { id, severity: "ok", source: "cron",
        message: `cron ${j.name} ok (on demand — started by ${DELIVERY_POLL_CRON_BASE})` };
    }
    return { id, severity: "warn", source: "cron", message: `cron ${j.name} is disabled` };
  }
  if (spec?.onDemand && j.enabled) {
    return { id, severity: "warn", source: "cron",
      message: `cron ${j.name} runs on its own schedule instead of on demand`,
      detail: `Its queue is empty on the great majority of runs, so a scheduled copy spends model turns discovering there is nothing to do — and on OpenClaw 2026.8+ each empty turn delivers a placeholder sentence. Re-run install.sh so ${DELIVERY_POLL_CRON_BASE} gates it, or disable it with \`openclaw cron disable ${j.id ?? "<job-id>"}\`.` };
  }
  if (c.extraMatches?.length) {
    return { id, severity: "warn", source: "cron",
      message: `cron ${j.name} ok, but duplicate job(s) exist: ${c.extraMatches.join(", ")}`,
      detail: "Old jobs from a previous installer can shadow the real one in ad-hoc checks, and they keep running on their own schedules.",
      fix: { autofixable: true, kind: "cron-delete",
        description: `delete duplicate job(s) ${c.extraMatches.join(", ")}`,
        payload: { names: c.extraMatches } } };
  }
  return { id, severity: "ok", source: "cron", message: `cron ${j.name} ok` };
}

// The suite's earlier naming generation. Not cosmetic: those jobs shipped
// `delivery: { mode: "announce" }` alongside prompts asking for the literal
// "SILENT_REPLY_TOKEN", so on 2026.8+ they announce on every single run. The
// rename to the current names was never a migration, so an install that
// upgraded across it runs both generations at once.
function legacyCronFinding(i: DoctorInputs): Finding | undefined {
  if (!i.legacyCronJobs?.length) return undefined;
  return {
    id: "cron:legacy-pass-jobs", severity: "error", source: "cron",
    message: `${i.legacyCronJobs.length} superseded job(s) from an older sapience install are still registered: ${i.legacyCronJobs.join(", ")}`,
    detail: "These predate the current job names and were never migrated. They carry an announce delivery route and a prompt that asks for a silent token the runtime does not recognize, so on OpenClaw 2026.8+ every one of their runs delivers text to your chat. The current jobs already do their work.",
    fix: { autofixable: true, kind: "cron-delete",
      description: `delete superseded job(s) ${i.legacyCronJobs.join(", ")}`,
      payload: { names: i.legacyCronJobs } },
  };
}

// SAP-8: report, do not assume. openclaw documents that "jobs created by an
// agent are capped to the tools available to that creating turn", which fully
// explains a snapshot of suite tool names in an unrelated job — but the
// alternative (the suite widening a third-party job's policy) would be a
// permissions problem, and only looking tells them apart.
function foreignToolPolicyFinding(i: DoctorInputs): Finding | undefined {
  if (!i.foreignJobsWithSuiteTools?.length) return undefined;
  return {
    id: "cron:foreign-tool-policy", severity: "ok", source: "cron",
    message: `${i.foreignJobsWithSuiteTools.length} non-suite job(s) carry suite tool names in their tool policy: ${i.foreignJobsWithSuiteTools.join(", ")}`,
    detail: "Expected when the job was created during a turn that had the suite's tools loaded — openclaw caps an agent-created job to that turn's tools and stores the snapshot. Nothing to fix unless you created one of these jobs somewhere the suite's tools were not loaded.",
  };
}

function hostSection(i: DoctorInputs): Section {
  const { version, error } = i.host ?? {};
  if (!version) {
    return { title: "HOST", findings: [{
      id: "host:version", severity: "warn", source: "config",
      message: "could not determine the OpenClaw version",
      detail: `The suite supports OpenClaw ${MIN_SUPPORTED_HOST_VERSION} and newer; without a version it cannot check whether this host is one of them. \`openclaw --version\` ${error ? `failed: ${error}` : "returned nothing recognizable"}.`,
    }] };
  }
  if (!isSupportedHost(version)) {
    return { title: "HOST", findings: [{
      id: "host:version", severity: "error", source: "config",
      message: `OpenClaw ${version} is older than the suite's supported floor (${MIN_SUPPORTED_HOST_VERSION})`,
      detail: `The suite registers jobs with --declaration-key, --light-context and command payloads, none of which this host understands. Upgrade OpenClaw, or pin the suite to a release that supported ${version}.`,
    }] };
  }
  const strict = hasStrictSilenceContract(version);
  return { title: "HOST", findings: [{
    id: "host:version", severity: "ok", source: "config",
    message: `OpenClaw ${version} supported${strict ? " (strict silence: only a bare NO_REPLY is quiet)" : ""}`,
    ...(strict ? { detail: "From 2026.8.1 a scheduled job with a delivery route has one quiet path: a reply that is the bare token and nothing else. Saying anything alongside the token delivers the remainder, and producing no text at all delivers a placeholder sentence. The suite's jobs are configured for that." } : {}),
  }] };
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
      const hint = SUITE_FILES.find((sf) => sf.label === f.label)?.absentHint;
      findings.push({ id: `file:${f.label}`, severity: "warn", source: "fs",
        message: `${f.label} not found`,
        detail: `${f.path} — ${hint ?? "may be normal if there has been no activity yet."}` });
    }
  }

  if (i.pendingProposals.count > 0) {
    const oldestMs = i.pendingProposals.oldestAt ? Date.parse(i.pendingProposals.oldestAt) : undefined;
    const stale = oldestMs !== undefined && i.nowMs - oldestMs > 48 * 60 * 60 * 1000;
    findings.push({
      id: "paths:pending-proposals",
      severity: stale ? "warn" : "ok",
      source: "fs",
      message: `${i.pendingProposals.count} proposal(s) pending your response${oldestMs ? ` (oldest ${ageStr(i.nowMs, oldestMs)})` : ""}`,
      detail: stale
        ? "Proposals surface on your next main-session message; priority 4+ push through the channel. A days-old queue means they aren't reaching you — check push settings and item_delivered/push_requested events."
        : undefined,
    });
  }

  if (i.corruptFiles.length > 0) {
    findings.push({ id: "paths:corrupt-files", severity: "warn", source: "fs",
      message: `${i.corruptFiles.length} quarantined state file(s) found`,
      detail: `A state file failed to parse and was reset; the original data is preserved at: ${i.corruptFiles.join(", ")}` });
  }
  appendDeliveryTargetFinding(findings, i);
  return { title: "PATHS", findings };
}

// Deliveries land in the agent main session by default — which, whenever
// session.dmScope isolates DMs into per-peer sessions, is a machine-only
// session no human converses in. Proposals sent there ask questions whose
// answers can never arrive.
function appendDeliveryTargetFinding(findings: Finding[], i: DoctorInputs): void {
  const dt = i.deliveryTarget;
  if (!dt) return;
  const id = "delivery:target";
  const scope = dt.dmScope ?? "main";
  const configured = Object.values(dt.configuredKeys).find((v) => typeof v === "string" && v);
  if (scope === "main") {
    findings.push({ id, severity: "ok", source: "config",
      message: "deliveries target the main session (dmScope main — DMs share it)" });
    return;
  }
  if (!configured) {
    const newest = dt.candidateSessions[0]; // already sorted newest-first by gatherInputs
    if (newest) {
      findings.push({ id, severity: "warn", source: "config",
        message: `the suite doesn't know where to send deliveries — dmScope=${scope} makes the main session machine-only and no delivery.sessionKey is configured`,
        detail: `Most recent operator conversation: ${newest.key}. The fix below routes all three delivering plugins there; to choose a different target, set plugins.entries.<plugin>.config.delivery.sessionKey for each suite plugin.`,
        fix: { autofixable: true, kind: "delivery-target-set",
          description: `route suite deliveries to ${newest.key}`,
          payload: { sessionKey: newest.key } } });
      return;
    }
    findings.push({ id, severity: "warn", source: "config",
      message: `the suite doesn't know where to send deliveries — dmScope=${scope} makes the main session machine-only and no delivery.sessionKey is configured`,
      detail: "No operator conversations found in the session store yet. Message the assistant once from your chat app, then re-run `openclaw sapience doctor --fix`." });
    return;
  }
  if (dt.configuredKeyExists === false) {
    findings.push({ id, severity: "warn", source: "config",
      message: `configured delivery session ${configured} is not in the session store`,
      detail: "Deliveries will fall back to gateway resolution and may go nowhere. Check the key for typos, or re-run `openclaw sapience doctor --fix` after messaging the assistant." });
    return;
  }
  findings.push({ id, severity: "ok", source: "config",
    message: `deliveries target ${configured}` });
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

// Core's create_goal/get_goal/update_goal collide by name with sapience-goals'
// goal_* tools, and the two mean opposite things: core's goal is a per-thread
// token budget that dies with the session, ours survives it. An agent asked for a
// long-running goal that reaches for create_goal loses the objective silently, so
// on installs that aren't doing coding work the fix is to remove the collision.
function goalToolSection(i: DoctorInputs): Section {
  const c = i.goalToolCollision;
  if (c.reachable.length === 0) {
    // Nothing reachable means one of two causes, and they deserve different
    // messages: the tools were denied, or the profile never exposed them. Testing
    // deny is enough to tell them apart — goalToolCollision() only empties
    // `reachable` for those two reasons.
    return { title: "TOOLS", findings: [{
      id: "tools:goal-collision", severity: "ok", source: "config",
      message: c.deny.length > 0 && CORE_GOAL_TOOLS.some((t) => c.deny.includes(t))
        ? "core goal tools denied — no collision with goal_submit"
        : `tools.profile "${c.profile}" does not expose core's goal tools`,
    }] };
  }
  // Merge rather than replace: tools.deny is shared config and may already be
  // denying unrelated tools (browser, exec). Writing a bare array would drop them.
  const merged = [...c.deny, ...c.reachable];
  return { title: "TOOLS", findings: [{
    id: "tools:goal-collision", severity: "warn", source: "config",
    message: `core's ${c.reachable.join("/")} reachable alongside sapience-goals`,
    detail: `Core's goal tools track a per-thread token budget and expire with the session — unrelated to goal_submit despite the names. Agents asked for a goal that survives sessions reach for create_goal and the goal is lost. Denying them removes the ambiguity. Skip this fix if this agent also does coding work and uses per-thread token budgets: it takes the tools away from every session on this host.`,
    fix: { autofixable: true, kind: "config-set",
      description: `deny ${c.reachable.join(", ")}`,
      payload: { path: "tools.deny", value: merged } },
  }] };
}

export function buildSuiteDoctorReport(i: DoctorInputs): DoctorReport {
  // When the listing itself failed we could not observe crons at all — one
  // honest error, no per-cron "not registered" assertions, no autofix bait.
  const strictSilenceHost = hasStrictSilenceContract(i.host?.version);
  const cronFindings: Finding[] = i.cronListing.available
    ? [
        ...i.crons.map((c) => cronFinding(c, i.modelAllowlist, i.pluginToolsAllowedGlobally, strictSilenceHost)),
        ...[legacyCronFinding(i), foreignToolPolicyFinding(i)].filter((f): f is Finding => Boolean(f)),
      ]
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
    hostSection(i),
    { title: "PLUGINS", findings: i.plugins.map((p) => pluginFinding(p, i.nowMs, {
      siblingAlive: [...freshIds].some((fid) => fid !== p.id),
      onDisk: onDiskByPlugin.get(p.id),
    })) },
    { title: "CRONS", findings: cronFindings },
    pathsSection(i),
    memorySection(i),
  ];
  // Only meaningful while sapience-goals is installed — without it there are no
  // goal_* tools for core's to be confused with.
  if (i.goalToolCollision.goalsPluginInstalled) {
    sections.push(goalToolSection(i));
  }
  if (i.versions.length > 0) {
    sections.push({ title: "VERSIONS", findings: i.versions.map(versionFinding) });
  }

  const summary = { ok: 0, warn: 0, error: 0 };
  for (const s of sections) for (const f of s.findings) summary[f.severity]++;

  return { sections, summary, exitCode: summary.error > 0 ? 1 : 0 };
}

// Doctor report schema + the observation inputs the pure core consumes.
// All I/O happens in sources.ts; the core (report.ts) is pure over these inputs.

export type Severity = "ok" | "warn" | "error";
export type FindingSource = "artifact" | "fs" | "resolver" | "config" | "cron";

export interface FixDescriptor {
  autofixable: boolean;
  description: string;
  kind: "config-set" | "cron-register" | "cron-delete" | "plugin-update" | "delivery-target-set";
  // For config-set: { path, value }. For cron-register: { base }.
  // For cron-delete: { names: string[] } — superseded jobs from an earlier
  // naming generation. For plugin-update: { pluginId }. For
  // delivery-target-set: { sessionKey } (applied to every suite plugin's
  // delivery.sessionKey).
  payload?: Record<string, unknown>;
}

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  detail?: string;
  source?: FindingSource;
  fix?: FixDescriptor;
}

export interface Section {
  title: string;
  findings: Finding[];
}

export interface DoctorReport {
  sections: Section[];
  summary: { ok: number; warn: number; error: number };
  exitCode: number;
}

// ── Observation inputs (gathered by sources.ts) ──────────────────────────────

// What a suite plugin recorded about itself at init.
export interface StatusArtifact {
  pluginId: string;
  version: string;
  agentId: string;
  resolvedWorkspaceDir: string;
  outputPaths: Record<string, string>;
  // sapience-feedback only: "message-hook" when passive capture registered,
  // "command-only" when the gateway lacks the hook surface.
  captureMode?: "message-hook" | "command-only";
  // Set when register() failed in a real gateway runtime — the error that
  // would otherwise vanish into a silent bail.
  initError?: string;
  initAt: string;
}

export interface PluginObservation {
  id: string;                       // e.g. "sapience-thinking"
  installed: boolean;               // present in OpenClawConfig plugin entries
  artifact?: StatusArtifact;        // present iff register() ran to completion
}

// Minimal slice of an OpenClaw cron job (see CronJob in the SDK).
export interface CronObservation {
  base: string;                     // expected base name, e.g. "sapience-thinking"
  job?: {
    id?: string;                    // gateway job id — `openclaw cron get` wants this, not the name
    name: string;
    enabled: boolean;
    payloadModel?: string;
    lastStatus?: string;
    consecutiveErrors?: number;
    toolsAllow?: string[];          // payload.toolsAllow — the session's plugin-tool grant
    declarationKey?: string;        // stable identity; absent on pre-declaration-key jobs
    // Whether the job carries a live announce delivery route. On openclaw
    // 2026.8+ an announce job publishes the runner's empty-turn placeholder
    // text, so a route on a job that should be silent is a defect.
    announces?: boolean;
    // The job's own explicit delivery route, when it has one. Replacing a job
    // must not lose it: the doctor learns the operator's target from
    // SAPIENCE_DELIVERY_* env vars, which are set when install.sh runs but not
    // when someone types `openclaw sapience doctor --fix`. Without this the
    // replacement silently reverts a pinned job to announce/last.
    deliveryChannel?: string;
    deliveryTo?: string;
    // payload.message — checked for the literal "SILENT_REPLY_TOKEN", which an
    // earlier generation of these prompts shipped in place of its value.
    message?: string;
    // Command payloads never start an agent turn, so tool grants, light
    // context and model pinning do not apply to them.
    isCommandPayload?: boolean;
  };
  // Other jobs whose names also matched this base (e.g. a legacy
  // "sapience-thinking-pass" left behind by an old installer). These can
  // shadow the real job in ad-hoc checks and confuse debugging.
  extraMatches?: string[];
}

export interface FileObservation {
  label: string;                    // e.g. "sapience/events.jsonl"
  path: string;                     // absolute, as the plugin actually resolves it
  exists: boolean;
  mtimeMs?: number;
  staleAfterMs?: number;            // from inventory: fresh writes expected each cron cycle
}

// Version reality per plugin, for skew detection.
export interface VersionObservation {
  pluginId: string;
  running?: string;                 // from the status artifact (what the gateway loaded)
  onDisk?: string;                  // from the installed package under <state>/npm/projects
  registryLatest?: string;          // from the npm registry (best-effort, may be absent)
  legacyRootPin?: string;           // stale pin in the legacy top-level <state>/npm/package.json
}

export interface WorkspaceObservation {
  resolved: string;
  source: "artifact" | "resolver";  // artifact = observed truth; resolver = computed fallback
}

export interface MemoryObservation {
  wikiInstalled: boolean;
  dreamingEnabled?: boolean;
  vaultMode?: string;
  bridgeEnabled?: boolean;
  searchCorpus?: string;
}

// The create_goal/goal_submit name collision: whether core's goal tools are
// actually reachable in agent sessions while sapience-goals is installed.
export interface GoalToolCollisionObservation {
  goalsPluginInstalled: boolean;
  profile?: string;                 // tools.profile, if set
  deny: string[];                   // tools.deny as configured
  // Core goal tools the profile exposes that tools.deny has not removed. Empty
  // means no collision — either the profile excludes them or they're denied.
  reachable: string[];
}

export interface DoctorInputs {
  plugins: PluginObservation[];
  crons: CronObservation[];
  modelAllowlist: string[];
  // True when the gateway config exposes plugin tools to every session (no
  // restrictive tools.profile, or group:plugins in tools.allow/alsoAllow).
  pluginToolsAllowedGlobally: boolean;
  goalToolCollision: GoalToolCollisionObservation;
  // Whether `openclaw cron list --json` actually succeeded. When it didn't,
  // crons is empty because we COULDN'T LOOK — not because nothing exists.
  cronListing: { available: boolean; error?: string };
  versions: VersionObservation[];
  // Quarantined state files (*.corrupt-*) found in the workspace — evidence
  // that a state file was corrupted and reset.
  corruptFiles: string[];
  // Outstanding proposal queue from the outcome tracker.
  pendingProposals: { count: number; oldestAt?: string };
  workspace: WorkspaceObservation;
  files: FileObservation[];
  memory: MemoryObservation;
  // Where suite deliveries land. On dmScope != main installs the agent main
  // session is machine-only, so an unconfigured delivery.sessionKey means
  // proposals are sent where no human converses.
  deliveryTarget?: {
    dmScope?: string;
    configuredKeys: Record<string, string | undefined>;
    candidateSessions: Array<{ key: string; updatedAt?: number }>;
    configuredKeyExists?: boolean;
  };
  // The OpenClaw host the suite is running against. Its version decides what a
  // scheduled job has to do to stay quiet — see doctor/host-version.ts.
  host: import("./host-version.js").HostVersionObservation;
  // Suite jobs from the earlier "-pass" naming generation. Those carry an
  // announce route AND a prompt asking for the literal "SILENT_REPLY_TOKEN", so
  // on 2026.8+ they announce on every run.
  legacyCronJobs: string[];
  // Non-suite jobs whose stored toolsAllow carries suite tool names. Usually
  // benign (openclaw caps an agent-created job to the creating turn's tools),
  // but worth being able to confirm rather than assume.
  foreignJobsWithSuiteTools: string[];
  nowMs: number;                    // injected for deterministic mtime/staleness math
}

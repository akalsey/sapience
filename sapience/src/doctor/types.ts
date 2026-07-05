// Doctor report schema + the observation inputs the pure core consumes.
// All I/O happens in sources.ts; the core (report.ts) is pure over these inputs.

export type Severity = "ok" | "warn" | "error";
export type FindingSource = "artifact" | "fs" | "resolver" | "config" | "cron";

export interface FixDescriptor {
  autofixable: boolean;
  description: string;
  kind: "config-set" | "cron-register";
  // For config-set: { path, value }. For cron-register: { base }.
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
    name: string;
    enabled: boolean;
    payloadModel?: string;
    lastStatus?: string;
    consecutiveErrors?: number;
    toolsAllow?: string[];          // payload.toolsAllow — the session's plugin-tool grant
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

export interface DoctorInputs {
  plugins: PluginObservation[];
  crons: CronObservation[];
  modelAllowlist: string[];
  // True when the gateway config exposes plugin tools to every session (no
  // restrictive tools.profile, or group:plugins in tools.allow/alsoAllow).
  pluginToolsAllowedGlobally: boolean;
  versions: VersionObservation[];
  // Quarantined state files (*.corrupt-*) found in the workspace — evidence
  // that a state file was corrupted and reset.
  corruptFiles: string[];
  workspace: WorkspaceObservation;
  files: FileObservation[];
  memory: MemoryObservation;
  nowMs: number;                    // injected for deterministic mtime/staleness math
}

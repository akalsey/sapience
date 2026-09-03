// The expected shape of a healthy sapience-suite install. Single source of truth
// for what the doctor checks against.

export const SUITE_PLUGINS = [
  "sapience-thinking",
  "sapience",
  "sapience-feedback",
  "sapience-goals",
] as const;

// Plugins that share the delivery.sessionKey convention (sapience-feedback
// never injects, so it's excluded).
export const DELIVERING_PLUGINS = ["sapience", "sapience-thinking", "sapience-goals"] as const;

// Plugins whose cron-driven tools refresh their status artifact on every run,
// so an old initAt IS a load-failure signal. Plugins absent from this set
// (sapience-feedback is hook-driven) write their artifact only at register();
// their initAt ages past ARTIFACT_STALE_MS in normal operation and must not
// be treated as stale.
export const CRON_REFRESHED_PLUGINS: ReadonlySet<string> = new Set([
  "sapience-thinking",
  "sapience",
  "sapience-goals",
]);

export const SUITE_CRON_SCHEDULE = "*/15 * * * *";

export const DELIVERY_CRON_BASE = "sapience-delivery";
// Deliberately NOT "sapience-delivery-poll": multi-agent installs append
// "-<agent>" to every base name, and the doctor matches jobs by "<base>-"
// prefix, so a name under the delivery prefix would be indistinguishable from
// "sapience-delivery-<agent>".
export const DELIVERY_POLL_CRON_BASE = "sapience-poll-delivery";

// Declaration keys make registration idempotent: openclaw matches an existing
// job carrying the same key and updates it in place. Without them, every
// installer run minted a new job — one production install accumulated two rows
// each for three jobs, created eight days apart — and a rename orphaned the old
// generation instead of migrating it. The "heartbeat:", "heartbeat-task:" and
// "skill-collection-review:" namespaces belong to the gateway; "sapience:" is
// ours. Multi-agent installs suffix the key with ":<agent>", which keeps each
// agent's copy a distinct declaration rather than an ambiguous match.
export const DECLARATION_KEY_PREFIX = "sapience";
export const DELIVERY_DECLARATION_KEY = `${DECLARATION_KEY_PREFIX}:delivery`;

export function qualifyDeclarationKey(key: string, agentId?: string): string {
  return agentId ? `${key}:${agentId}` : key;
}

// Cron jobs the installer registers (multi-agent installs append "-<agent>";
// the doctor matches a job whose name equals the base or starts with "<base>-").
// `tools` becomes the job's payload.toolsAllow — isolated cron sessions only see
// plugin tools granted here (or via a global tools.allow/alsoAllow), so a cron
// registered without its grant runs "ok" while the agent can't call anything.
// Keep base names, tools, and messages in sync with install.sh.
export type SuiteCronSpec = {
  base: string;
  declarationKey: string;
  tools: readonly string[];
  message: string;
  // Cron announce delivery routes the run's final reply to the last active
  // channel. The delivery cron is the suite's channel-reaching fallback while
  // main-session injection is voided by the gateway's registration guard
  // (openclaw PR #111131) — announce is the one delivery path stock openclaw
  // grants globally-installed plugins.
  announce?: boolean;
  // Registered, but with no schedule of its own — sapience-poll-delivery runs
  // it on demand. See onDemandRationale below.
  onDemand?: boolean;
};

// Why the delivery job no longer runs on a schedule of its own:
//
// Its queue is empty ~95% of the time, so ~95% of its runs existed only to
// learn there was nothing to do. That was free while an empty agent turn was
// silent. At openclaw 2026.8.1 it stopped being free — the runner now
// substitutes a placeholder sentence when a model ends a tool-only turn without
// text, and an announce route delivers that placeholder. Ninety-six times a day.
//
// sapience-poll-delivery reads the queue in plugin code (a command payload: no
// model, no context, no delivery route) and triggers this job only when there
// is something to send. Command payloads are used rather than openclaw's
// --trigger-script gate because trigger scripts require cron.triggers.enabled,
// which grants headless exec with the owning agent's full tool policy.
export const SUITE_CRONS: ReadonlyArray<SuiteCronSpec> = [
  {
    base: "sapience-thinking",
    declarationKey: `${DECLARATION_KEY_PREFIX}:thinking`,
    tools: ["get_thinking_context", "record_thinking_output"],
    message:
      "You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions. If it returns {status:skip}, reply with NO_REPLY and stop. Otherwise review the context carefully, then call record_thinking_output() with your proposals. Do not produce any other output. If the tool is not available, reply NO_REPLY and stop.",
  },
  {
    base: "sapience-routing",
    declarationKey: `${DECLARATION_KEY_PREFIX}:routing`,
    tools: ["process_proposals"],
    message:
      "You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop.",
  },
  {
    base: "sapience-goals-check",
    declarationKey: `${DECLARATION_KEY_PREFIX}:goals-check`,
    tools: ["check_goals"],
    message:
      "You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop.",
  },
  {
    base: DELIVERY_CRON_BASE,
    declarationKey: DELIVERY_DECLARATION_KEY,
    tools: ["get_pending_deliveries"],
    announce: true,
    onDemand: true,
    message:
      "You are the sapience delivery agent. Call get_pending_deliveries() to fetch notifications that could not reach the user through the normal path. If it returns NOTHING_PENDING, reply NO_REPLY and stop. Otherwise compose ONE concise message to the user covering every pending item — lead with the most important, keep it brief, and write as the assistant speaking directly to the user; your final reply is delivered to their chat. If the tool is not available, reply NO_REPLY and stop.",
  },
];

export const SUITE_CRON_BASES = SUITE_CRONS.map((c) => c.base);

// The polling job. A command payload, so no model turn, no bootstrap context,
// and no delivery route — it prints the silent token and nothing else. See
// sapience/src/delivery-gate-cli.ts for why it must never write to stderr.
export const DELIVERY_POLL_CRON = {
  base: DELIVERY_POLL_CRON_BASE,
  declarationKey: `${DECLARATION_KEY_PREFIX}:poll-delivery`,
  // Registered with --command-argv and an ABSOLUTE path, never
  // --command "openclaw sapience deliver-check". The Gateway runs a shell
  // command payload as `sh -lc`, and on Debian/Ubuntu sh is dash, whose login
  // shell reads /etc/profile but not ~/.bashrc — where an npm-global bin
  // directory usually lands. A production install failed ten consecutive runs
  // with `sh: 1: openclaw: not found` (exit 127) and auto-disabled itself,
  // while the identical command worked by hand in the operator's own shell.
  subcommand: ["sapience", "deliver-check"] as readonly string[],
} as const;

// argv for the poll job: the resolved openclaw binary plus the subcommand.
export function deliveryPollArgv(openclawBin: string): string[] {
  return [openclawBin, ...DELIVERY_POLL_CRON.subcommand];
}

// Every job the installer registers, including the command-payload poll job.
export const ALL_SUITE_CRON_BASES: readonly string[] = [...SUITE_CRON_BASES, DELIVERY_POLL_CRON_BASE];

export function cronSpecFor(base: string): SuiteCronSpec | undefined {
  return SUITE_CRONS.find((c) => c.base === base || base.startsWith(`${c.base}-`));
}

// The suite's whole tool surface, for spotting it in an unrelated job's stored
// tool policy. Kept broader than the cron grants above on purpose: the point is
// to recognize any suite tool wherever it turns up.
export const SUITE_TOOL_NAMES: readonly string[] = [
  "get_pending_deliveries", "process_proposals", "check_goals",
  "get_thinking_context", "record_thinking_output", "record_outcome",
  "watch_metric", "watch_remove",
  "skill_proposal", "skill_proposal_update", "skill_proposal_list",
  "hypothesis_list", "hypothesis_resolve",
  "goal_select_approach", "goal_update", "goal_progress", "goal_blocker",
  "goal_set_metric", "goal_submit",
];

// Output files written under the resolved workspace dir (relative paths), with the
// plugin that owns each. Used for the PATHS section. Files with `staleAfterMs`
// are written on every (15-minute) cron cycle when the pipeline is healthy —
// an old mtime under green crons means the tool handlers aren't executing,
// which is exactly how the toolsAllow regression stayed invisible on an
// established install (old files existed, so nothing was "missing").
export const SUITE_FILES: ReadonlyArray<{ label: string; owner: string; staleAfterMs?: number; absentHint?: string }> = [
  { label: "proactive-thinking/log.md", owner: "sapience-thinking", staleAfterMs: 24 * 60 * 60 * 1000 },
  { label: "proactive-thinking/proposals.jsonl", owner: "sapience-thinking", staleAfterMs: 24 * 60 * 60 * 1000 },
  { label: "proactive-thinking/outcomes.json", owner: "sapience-thinking" },
  { label: "sapience/events.jsonl", owner: "sapience", staleAfterMs: 24 * 60 * 60 * 1000 },
  { label: "sapience/dashboard.md", owner: "sapience" },
  { label: "sapience/calibration.json", owner: "sapience" },
  { label: "sapience/action-log.md", owner: "sapience",
    absentHint: "created when the first act-tier action executes — act requires calibrated confidence built from record_outcome feedback, so a young install won't have one" },
  { label: "sapience/processed-passes.json", owner: "sapience" },
  { label: "goals/goals.json", owner: "sapience-goals",
    absentHint: "created on the first goal_submit — absent until someone asks the assistant to track a goal" },
  { label: "sapience/skill-proposals.json", owner: "sapience",
    absentHint: "created on the first skill_proposal — absent until the assistant notices a repeated multi-step task worth codifying" },
];

// Memory config the suite needs, with the config path and required value. Drives
// both the MEMORY checks and the --fix config-set descriptors.
export const MEMORY_SETTINGS: ReadonlyArray<{
  key: keyof import("./types.js").MemoryObservation;
  path: string;
  expected: string | boolean;
  label: string;
}> = [
  // Paths are the REAL `openclaw config set` shape (plugins.entries.<id>.config.<key>);
  // a short form like plugins.memory-wiki.vaultMode is rejected by the CLI and
  // shipped as broken advice/fixes for weeks before anyone caught it.
  { key: "dreamingEnabled", path: "plugins.entries.memory-core.config.dreaming.enabled", expected: true, label: "memory-core dreaming" },
  { key: "vaultMode", path: "plugins.entries.memory-wiki.config.vaultMode", expected: "bridge", label: "memory-wiki vaultMode" },
  { key: "bridgeEnabled", path: "plugins.entries.memory-wiki.config.bridge.enabled", expected: true, label: "memory-wiki bridge" },
  { key: "searchCorpus", path: "plugins.entries.memory-wiki.config.search.corpus", expected: "all", label: "memory-wiki search corpus" },
];

// OpenClaw core's own goal tools. They track a per-thread token budget that dies
// with the session — nothing to do with sapience-goals' durable goal_* tools, but
// the names collide well enough that agents reach for create_goal when asked for a
// goal that survives sessions, and the user's objective is silently lost.
export const CORE_GOAL_TOOLS = ["create_goal", "get_goal", "update_goal"];

// Tool profiles whose scope includes core's goal tools. Per
// docs.openclaw.ai/gateway/config-tools: "coding" covers filesystem, runtime, web,
// sessions, memory, goals, generation; "full" (or unset) restricts nothing.
// "minimal" and "messaging" exclude them, so there is no collision to fix there.
export const GOAL_TOOL_PROFILES = ["coding", "full"];

// A status artifact older than this is treated as stale (plugin may not be loading).
export const ARTIFACT_STALE_MS = 60 * 60 * 1000; // 1 hour

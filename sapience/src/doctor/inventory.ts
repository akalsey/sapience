// The expected shape of a healthy sapience-suite install. Single source of truth
// for what the doctor checks against.

export const SUITE_PLUGINS = [
  "sapience-thinking",
  "sapience",
  "sapience-feedback",
  "sapience-goals",
] as const;

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

// Cron jobs the installer registers (multi-agent installs append "-<agent>";
// the doctor matches a job whose name equals the base or starts with "<base>-").
// `tools` becomes the job's payload.toolsAllow — isolated cron sessions only see
// plugin tools granted here (or via a global tools.allow/alsoAllow), so a cron
// registered without its grant runs "ok" while the agent can't call anything.
// Keep base names, tools, and messages in sync with install.sh.
export const SUITE_CRONS: ReadonlyArray<{
  base: string;
  tools: readonly string[];
  message: string;
  // Cron announce delivery routes the run's final reply to the last active
  // channel. The delivery cron is the suite's channel-reaching fallback while
  // main-session injection is voided by the gateway's registration guard
  // (openclaw PR #111131) — announce is the one delivery path stock openclaw
  // grants globally-installed plugins.
  announce?: boolean;
}> = [
  {
    base: "sapience-thinking",
    tools: ["get_thinking_context", "record_thinking_output"],
    message:
      "You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions. If it returns {status:skip}, reply with NO_REPLY and stop. Otherwise review the context carefully, then call record_thinking_output() with your proposals. Do not produce any other output. If the tool is not available, reply NO_REPLY and stop.",
  },
  {
    base: "sapience-routing",
    tools: ["process_proposals"],
    message:
      "You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop.",
  },
  {
    base: "sapience-goals-check",
    tools: ["check_goals"],
    message:
      "You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop.",
  },
  {
    base: "sapience-delivery",
    tools: ["get_pending_deliveries"],
    announce: true,
    message:
      "You are the sapience delivery agent. Call get_pending_deliveries() to fetch notifications that could not reach the user through the normal path. If it returns NOTHING_PENDING, reply NO_REPLY and stop. Otherwise compose ONE concise message to the user covering every pending item — lead with the most important, keep it brief, and write as the assistant speaking directly to the user; your final reply is delivered to their chat. If the tool is not available, reply NO_REPLY and stop.",
  },
];

export const SUITE_CRON_BASES = SUITE_CRONS.map((c) => c.base);

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

// A status artifact older than this is treated as stale (plugin may not be loading).
export const ARTIFACT_STALE_MS = 60 * 60 * 1000; // 1 hour

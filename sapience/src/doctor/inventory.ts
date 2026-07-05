// The expected shape of a healthy sapience-suite install. Single source of truth
// for what the doctor checks against.

export const SUITE_PLUGINS = [
  "sapience-thinking",
  "sapience",
  "sapience-feedback",
  "sapience-goals",
] as const;

// Cron jobs the installer registers (multi-agent installs append "-<agent>";
// the doctor matches a job whose name equals the base or starts with "<base>-").
// `tools` becomes the job's payload.toolsAllow — isolated cron sessions only see
// plugin tools granted here (or via a global tools.allow/alsoAllow), so a cron
// registered without its grant runs "ok" while the agent can't call anything.
// Keep base names, tools, and messages in sync with install.sh.
export const SUITE_CRONS: ReadonlyArray<{ base: string; tools: readonly string[]; message: string }> = [
  {
    base: "sapience-thinking",
    tools: ["get_thinking_context", "record_thinking_output"],
    message:
      "You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions. If it returns {status:skip}, reply with SILENT_REPLY_TOKEN and stop. Otherwise review the context carefully, then call record_thinking_output() with your proposals. Do not produce any other output. If the tool is not available, reply SILENT_REPLY_TOKEN and stop.",
  },
  {
    base: "sapience-routing",
    tools: ["process_proposals"],
    message:
      "You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals. Reply SILENT_REPLY_TOKEN after the tool call. If the tool is not available, reply SILENT_REPLY_TOKEN and stop.",
  },
  {
    base: "sapience-goals-check",
    tools: ["check_goals"],
    message:
      "You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply SILENT_REPLY_TOKEN after the tool call. If the tool is not available, reply SILENT_REPLY_TOKEN and stop.",
  },
];

export const SUITE_CRON_BASES = SUITE_CRONS.map((c) => c.base);

// Output files written under the resolved workspace dir (relative paths), with the
// plugin that owns each. Used for the PATHS section.
export const SUITE_FILES: ReadonlyArray<{ label: string; owner: string }> = [
  { label: "proactive-thinking/log.md", owner: "sapience-thinking" },
  { label: "proactive-thinking/proposals.jsonl", owner: "sapience-thinking" },
  { label: "proactive-thinking/outcomes.json", owner: "sapience-thinking" },
  { label: "sapience/events.jsonl", owner: "sapience" },
  { label: "sapience/dashboard.md", owner: "sapience" },
  { label: "sapience/calibration.json", owner: "sapience" },
  { label: "sapience/action-log.md", owner: "sapience" },
  { label: "sapience/processed-passes.json", owner: "sapience" },
  { label: "goals/goals.json", owner: "sapience-goals" },
];

// Memory config the suite needs, with the config path and required value. Drives
// both the MEMORY checks and the --fix config-set descriptors.
export const MEMORY_SETTINGS: ReadonlyArray<{
  key: keyof import("./types.js").MemoryObservation;
  path: string;
  expected: string | boolean;
  label: string;
}> = [
  { key: "dreamingEnabled", path: "plugins.memory-core.dreaming.enabled", expected: true, label: "memory-core dreaming" },
  { key: "vaultMode", path: "plugins.memory-wiki.vaultMode", expected: "bridge", label: "memory-wiki vaultMode" },
  { key: "bridgeEnabled", path: "plugins.memory-wiki.bridge.enabled", expected: true, label: "memory-wiki bridge" },
  { key: "searchCorpus", path: "plugins.memory-wiki.search.corpus", expected: "all", label: "memory-wiki search corpus" },
];

// A status artifact older than this is treated as stale (plugin may not be loading).
export const ARTIFACT_STALE_MS = 60 * 60 * 1000; // 1 hour

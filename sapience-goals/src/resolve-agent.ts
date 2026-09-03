// Resolving the gateway's effective agent id from plugin config.
//
// Every plugin used to read `config.agent.id` and fall back to a literal —
// "default" in three plugins, "main" in the fourth. That path does not exist in
// openclaw's config at all: the roster lives under `agents.entries`, which is a
// keyed OBJECT (`{"main": {...}}`) on a real install, not a list. So the read
// always missed and the literal always won. Three plugins therefore wrote
// `agentId: "default"` into their status artifacts, and any cron job registered
// with that literal fails on every run with "cron job agent is unavailable:
// default" unless the install happens to have an agent by that name.
//
// Prefer omitting the agent entirely when registering a cron — openclaw's
// scheduler resolves the configured default itself. Use this resolver for the
// places that need a name to report or to scope a path.

function normalize(value: unknown): string | undefined {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  return s || undefined;
}

interface RosterEntry {
  id?: string;
  default?: boolean;
}

// Accepts both roster shapes openclaw has shipped: the keyed object under
// `agents.entries` (current) and a plain array (`agents.list`, and `entries`
// when authored as a list). An entry's own `id` wins over its object key so a
// renamed entry still reports its real id.
function listRosterEntries(config: any): RosterEntry[] {
  const roster = config?.agents?.entries ?? config?.agents?.list;
  if (Array.isArray(roster)) {
    return roster.filter((entry): entry is RosterEntry => Boolean(entry) && typeof entry === "object");
  }
  if (roster && typeof roster === "object") {
    return Object.entries(roster as Record<string, unknown>).map(([key, value]) => {
      const entry = (value && typeof value === "object" ? value : {}) as RosterEntry;
      return { ...entry, id: entry.id ?? key };
    });
  }
  return [];
}

// "main" is openclaw's own default agent id, and the only safe guess when the
// config carries no roster at all. It is a guess, though — callers registering
// cron jobs should omit the agent rather than pass this.
export const FALLBACK_AGENT_ID = "main";

export function resolveAgentId(config: any): string {
  return resolveRosterAgentId(config) ?? FALLBACK_AGENT_ID;
}

// The same resolution, but undefined rather than a guess when the config has no
// roster to resolve from. Cron registration must use this one: openclaw's
// scheduler resolves the configured default when `--agent` is omitted, and
// that is always better than passing a name that may not exist — a job created
// with an unavailable agent fails on every run, forever, with
// "cron job agent is unavailable: <name>".
export function resolveRegistrableAgentId(config: any): string | undefined {
  return resolveRosterAgentId(config);
}

function resolveRosterAgentId(config: any): string | undefined {
  const entries = listRosterEntries(config);
  const explicitDefault = entries.find((entry) => entry.default === true);
  const sole = entries.length === 1 ? entries[0] : undefined;
  return normalize(explicitDefault?.id) ?? normalize(sole?.id) ?? normalize(entries[0]?.id);
}

// Resolving and injecting into the gateway's main session.
//
// The gateway's enqueueNextTurnInjection takes { sessionKey, text } and
// SILENTLY returns { enqueued: false } for anything else — the suite
// originally passed { sessionTarget: "main" }, so no injection was ever
// delivered. The key format mirrors the gateway's buildMainSessionKey
// (verified against the openclaw dist): `agent:<agentId>:<mainKey>`,
// lowercased, with a "global" short-circuit for global session scope.

function normalize(value: unknown, fallback: string): string {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  return s || fallback;
}

export function resolveMainSessionKey(config: any): string {
  if (config?.session?.scope === "global") return "global";
  const agents: any[] = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const agentId = normalize(agents.find((a) => a?.default)?.id ?? agents[0]?.id, "main");
  const mainKey = normalize(config?.session?.mainKey, "main");
  return `agent:${agentId}:${mainKey}`;
}

export interface InjectionResult {
  enqueued: boolean;
  reason?: string;
}

export async function enqueueMainSessionInjection(api: any, text: string): Promise<InjectionResult> {
  const enqueue = api?.session?.workflow?.enqueueNextTurnInjection;
  if (typeof enqueue !== "function") {
    return { enqueued: false, reason: "injection API unavailable" };
  }
  try {
    const result = await enqueue({ sessionKey: resolveMainSessionKey(api?.config), text });
    if (result?.enqueued === true) return { enqueued: true };
    return { enqueued: false, reason: "gateway declined the injection" };
  } catch (err) {
    return { enqueued: false, reason: String(err) };
  }
}

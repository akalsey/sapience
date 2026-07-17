// Resolving and injecting into the gateway's main session.
//
// The gateway's enqueueNextTurnInjection takes { sessionKey, text } and
// SILENTLY returns { enqueued: false } for anything else. The key format
// mirrors the gateway's buildMainSessionKey (verified against the openclaw
// dist): `agent:<agentId>:<mainKey>`, lowercased, with a "global"
// short-circuit for global session scope.

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

// The gateway returns the same {enqueued:false, id:"", sessionKey} for every
// decline, so the cause is invisible from the result alone. One asymmetry
// tells the two live failure modes apart: openclaw's noop stub (used in
// runtime contexts where the injection handler was never wired) echoes the
// sessionKey verbatim, while the real implementation trims it before any
// decline path. A trailing-space probe after a decline is therefore safe —
// the trimmed key is identical, so it can never enqueue where the first call
// declined — and its echo identifies which side failed.
async function diagnoseDecline(
  enqueue: (inj: { sessionKey: string; text: string }) => Promise<{ sessionKey?: string } | undefined>,
  sessionKey: string
): Promise<string> {
  try {
    const probeKey = `${sessionKey} `;
    const probe = await enqueue({ sessionKey: probeKey, text: "[sapience] delivery probe — ignore" });
    if (probe?.sessionKey === probeKey) {
      return "injection handler not wired in this runtime context (gateway noop echoed an untrimmed session key)";
    }
    if (probe?.sessionKey === sessionKey) {
      return `gateway ran but found no session entry for "${sessionKey}" in its store`;
    }
  } catch { /* fall through to the generic reason */ }
  return "gateway declined the injection";
}

export async function enqueueMainSessionInjection(api: any, text: string): Promise<InjectionResult> {
  const enqueue = api?.session?.workflow?.enqueueNextTurnInjection;
  if (typeof enqueue !== "function") {
    return { enqueued: false, reason: "injection API unavailable" };
  }
  const sessionKey = resolveMainSessionKey(api?.config);
  try {
    const result = await enqueue({ sessionKey, text });
    if (result?.enqueued === true) return { enqueued: true };
    return { enqueued: false, reason: await diagnoseDecline(enqueue, sessionKey) };
  } catch (err) {
    return { enqueued: false, reason: String(err) };
  }
}

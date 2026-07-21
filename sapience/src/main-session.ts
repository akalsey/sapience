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
  sessionKey: string,
  firstResult: unknown
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
    // Any other echoed key is the gateway's found-but-declined path, which
    // returns the store's canonical key (duplicate idempotency key or the
    // per-plugin injection queue cap). Surface the raw shapes.
    return `gateway found the session under canonical key ${JSON.stringify(probe?.sessionKey)} but declined (queue cap or duplicate); firstResult=${JSON.stringify(firstResult)} probeResult=${JSON.stringify(probe)}`;
  } catch { /* probe threw; return the generic reason below */ }
  return "gateway declined the injection";
}

export async function enqueueMainSessionInjection(api: any, text: string): Promise<InjectionResult> {
  const facade = api?.session?.workflow?.enqueueNextTurnInjection;
  const direct = api?.enqueueNextTurnInjection;
  const enqueue = facade ?? direct;
  if (typeof enqueue !== "function") {
    return { enqueued: false, reason: "injection API unavailable" };
  }
  // Multi-user installs keep the main session machine-only; a configured
  // delivery.sessionKey routes proposals into the operator's own conversation,
  // where their replies actually land (plugins.entries.<id>.config.delivery.sessionKey).
  const configured = api?.pluginConfig?.delivery?.sessionKey;
  const sessionKey =
    typeof configured === "string" && configured.trim()
      ? configured.trim().toLowerCase()
      : resolveMainSessionKey(api?.config);
  try {
    const result = await enqueue({ sessionKey, text });
    // An undefined result is openclaw's registration guard: after register()
    // completes, the guard proxy silently voids every api method not on its
    // late-callable allowlist, and enqueueNextTurnInjection isn't on it
    // (api-lifecycle.ts PLUGIN_API_METHOD_POLICIES). scheduleSessionTurn IS
    // late-callable — deliver by scheduling an immediate one-shot agent turn
    // in the main session instead.
    if (result === undefined) {
      const schedule = api?.session?.workflow?.scheduleSessionTurn ?? api?.scheduleSessionTurn;
      if (typeof schedule === "function") {
        const handle = await schedule({
          sessionKey,
          message: text,
          delayMs: 0,
          deleteAfterRun: true,
          deliveryMode: "announce",
          name: "sapience-delivery",
        });
        if (handle?.id) return { enqueued: true };
      }
      const scheduleStatus = `scheduleSessionTurn ${typeof schedule === "function" ? "returned no handle" : "unavailable"}`;
      if (enqueue !== direct && typeof direct === "function") { // facade returned undefined; try the flat method
        const directResult = await direct({ sessionKey, text });
        if (directResult?.enqueued === true) return { enqueued: true };
        return {
          enqueued: false,
          reason: `facade resolved undefined (fn=${String(enqueue).slice(0, 180)}); ${scheduleStatus}; flat api.enqueueNextTurnInjection ${directResult === undefined ? "also returned undefined" : `returned ${JSON.stringify(directResult)}`} (flatFn=${String(direct).slice(0, 300)})`,
        };
      }
      return {
        enqueued: false,
        reason: `facade resolved undefined (fn=${String(enqueue).slice(0, 180)}); ${scheduleStatus}; flat api.enqueueNextTurnInjection is missing`,
      };
    }
    if (result?.enqueued === true) return { enqueued: true };
    return { enqueued: false, reason: await diagnoseDecline(enqueue, sessionKey, result) };
  } catch (err) {
    return { enqueued: false, reason: String(err) };
  }
}

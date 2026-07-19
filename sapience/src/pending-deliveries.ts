import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

// Durable queue for deliveries the injection path couldn't land. On stock
// openclaw the registration guard voids enqueueNextTurnInjection for every
// plugin (see main-session.ts), so failed deliveries queue here and the
// sapience-delivery cron drains them through cron announce delivery — the one
// channel path that works for globally-installed plugins without patching the
// gateway. Once the upstream fix ships, injections succeed, nothing queues,
// and the cron idles on an empty file.

export interface PendingDelivery {
  id: string;                 // idempotency key: proposal id, or digest-<localDate>
  kind: "item" | "digest";
  prompt: string;
  queued_at: string;
}

// Bounds the file when delivery is down for a long stretch; oldest entries
// drop first — they also expire from the outcomes tracker on their own.
const MAX_PENDING = 50;

export async function addPendingDelivery(
  path: string,
  entry: Omit<PendingDelivery, "queued_at">
): Promise<boolean> {
  const queue = await readJsonSafe<PendingDelivery[]>(path, []);
  const entries = Array.isArray(queue) ? queue : [];
  if (entries.some((e) => e?.id === entry.id)) return false;
  entries.push({ ...entry, queued_at: new Date().toISOString() });
  await writeJsonAtomic(path, entries.slice(-MAX_PENDING));
  return true;
}

export async function drainPendingDeliveries(path: string): Promise<PendingDelivery[]> {
  const queue = await readJsonSafe<PendingDelivery[]>(path, []);
  const entries = (Array.isArray(queue) ? queue : []).filter(
    (e): e is PendingDelivery => Boolean(e && typeof e.id === "string" && typeof e.prompt === "string")
  );
  if (entries.length > 0) await writeJsonAtomic(path, []);
  return entries;
}

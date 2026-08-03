import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";
import { isNearDuplicate } from "./text-match.js";

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
  // The underlying finding, for content dedup. `prompt` can't serve: it is
  // wrapped in tier boilerplate that every item shares. Absent on entries
  // queued before this existed, which are treated as unmatchable.
  text?: string;
}

// Bounds the file when delivery is down for a long stretch; oldest entries
// drop first — they also expire from the outcomes tracker on their own.
const MAX_PENDING = 50;

// Rejects a duplicate id, and also a restatement of something already waiting.
//
// The queue releases one item per delivery-cron cycle, so twins never arrive
// together — they arrive as the same point made again fifteen minutes later,
// which is what the repetition looks like from the user's side. Aging entries
// out is not the answer: a proposal may legitimately wait days for someone to
// come back to it. The fix is that the twin never gets in.
//
// Production 2026-08-03 queued twelve items in a single second, made up of
// clusters of three near-identical observations each, because several leaked
// transcript listeners had each described the same turn in their own words.
export async function addPendingDelivery(
  path: string,
  entry: Omit<PendingDelivery, "queued_at">
): Promise<boolean> {
  const queue = await readJsonSafe<PendingDelivery[]>(path, []);
  const entries = Array.isArray(queue) ? queue : [];
  if (entries.some((e) => e?.id === entry.id)) return false;
  // Digests are periodic summaries, not findings: two of them overlapping in
  // wording is normal and must never suppress one.
  if (entry.kind !== "digest" && entry.text) {
    const restatesQueued = entries.some(
      (e) => e?.kind !== "digest" && e?.text && isNearDuplicate(e.text, entry.text!)
    );
    if (restatesQueued) return false;
  }
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

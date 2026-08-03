import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";
import { isNearDuplicate } from "./dedup.js";
import type { OutcomeMap } from "./types.js";

// Answering a proposal has to retire the rest of the queue it came from.
//
// Deliveries are capped per cycle (sapience `delivery.maxPerCycle`, default 1)
// and the overflow waits in a durable queue the delivery cron drains every 15
// minutes. That queue is a time-delay line: a burst of items generated in one
// minute arrives over the following hours, and nothing ever reconsidered them
// in light of what the user said in between.
//
// Production, 2026-08-02: one pass produced an observation about a reasoning
// flaw and the action derived from it. The user answered the observation at
// 18:17 with explicit direction. The sibling action was still queued, and the
// cron delivered it at 18:30 as a fresh "would you like me to, or shall I
// check with you first?" about the subject just settled — 13 minutes after the
// user had settled it. The user's word is the freshest signal in the system;
// anything queued from the same thought is stale the moment they respond.
//
// This is sapience's queue file, written here by the same workspace convention
// `adjustCalibration` already uses for calibration.json.

interface PendingDelivery {
  id: string;
  kind: "item" | "digest";
  prompt: string;
  queued_at: string;
}

// Retire everything queued that the just-answered proposal speaks for, and
// return the ids that went. Two ways an entry qualifies:
//
//   same pass  — one pass is one unit of reasoning. Its observation, and the
//                action derived from that observation, are facets of a single
//                thought; direction on one is direction on all of them.
//   same text  — the noticer can emit one remark several times under distinct
//                pass ids, so pass identity alone would leave the twins queued.
//
// An entry with no outcome record is left alone: absence is not evidence of
// staleness, and dropping on it would silently swallow anything the tracker
// has evicted.
export async function dropStaleQueuedDeliveries(
  pendingPath: string,
  outcomes: OutcomeMap,
  resolvedId: string
): Promise<string[]> {
  const resolved = outcomes[resolvedId];
  if (!resolved) return [];

  const load = async (): Promise<PendingDelivery[]> => {
    const queue = await readJsonSafe<PendingDelivery[]>(pendingPath, []);
    return Array.isArray(queue) ? queue : [];
  };

  const isStale = (entry: PendingDelivery): boolean => {
    if (entry?.kind === "digest") return false;
    const record = outcomes[entry?.id ?? ""];
    if (!record) return false;
    if (record.pass_id && record.pass_id === resolved.pass_id) return true;
    if (!record.text || !resolved.text) return false;
    return isNearDuplicate(record.text, resolved.text);
  };

  const staleIds = new Set((await load()).filter(isStale).map((e) => e.id));
  if (staleIds.size === 0) return [];

  // Re-read immediately before writing, and remove BY ID from whatever is on
  // disk now rather than writing back the list filtered a moment ago. This
  // file has three unsynchronized writers across two plugin processes —
  // sapience appends to it when a routing run overflows and empties it when
  // the delivery cron drains, and this runs from sapience-thinking — with no
  // shared lock. Writing a stale snapshot would clobber a drain that landed in
  // between and put already-delivered items back in the queue, which is the
  // repeat this whole module exists to stop. Filtering current contents means
  // a drain that already emptied the file simply leaves nothing to do.
  const current = await load();
  const kept = current.filter((e) => !staleIds.has(e.id));
  if (kept.length === current.length) return [];

  await writeJsonAtomic(pendingPath, kept);
  return current.filter((e) => staleIds.has(e.id)).map((e) => e.id);
}

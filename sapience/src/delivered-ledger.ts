import { createHash } from "crypto";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";
import type { SapienceItem } from "./types.js";

// Routing dedupes by pass_id, but the thinking model can re-emit the same
// proposal under a fresh uuid every pass — one directive was delivered dozens
// of times over days before anyone intervened. This ledger remembers what was
// recently delivered BY CONTENT: an item whose normalized text matches a
// recent delivery is suppressed until the window lapses, so a genuinely
// persistent issue resurfaces on the order of days, not every 15 minutes.

export const MAX_LEDGER_ENTRIES = 500;

interface LedgerEntry {
  key: string;
  ts: string;
}

export function itemKey(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export async function dedupeDelivered(
  path: string,
  items: SapienceItem[],
  windowHours: number,
  now: number = Date.now()
): Promise<{ fresh: SapienceItem[]; duplicates: SapienceItem[] }> {
  if (items.length === 0) return { fresh: [], duplicates: [] };

  const cutoff = now - windowHours * 60 * 60 * 1000;
  const entries = (await readJsonSafe<LedgerEntry[]>(path, [])).filter(
    (e) => Date.parse(e.ts) > cutoff
  );
  const seen = new Set(entries.map((e) => e.key));

  const fresh: SapienceItem[] = [];
  const duplicates: SapienceItem[] = [];
  for (const item of items) {
    const key = itemKey(item.text);
    if (seen.has(key)) {
      duplicates.push(item);
      continue;
    }
    seen.add(key);
    fresh.push(item);
    entries.push({ key, ts: new Date(now).toISOString() });
  }

  if (fresh.length > 0) {
    await writeJsonAtomic(path, entries.slice(-MAX_LEDGER_ENTRIES));
  }
  return { fresh, duplicates };
}

import { randomUUID } from "crypto";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

// The watch primitive: "keep an eye on X" as first-class state. A watch is a
// metric source + cadence + delta policy. Checks run during routing passes
// (a bounded read-only subagent fetches the value); the delta policy decides
// whether a reading is worth surfacing — a good analyst reports "steady" in
// the weekly digest, not every afternoon.

export type DeltaPolicy =
  | { kind: "percent"; threshold: number }   // notable when |Δ| vs baseline mean exceeds threshold %
  | { kind: "above"; threshold: number }     // notable when the value crosses above
  | { kind: "below"; threshold: number }     // notable when the value crosses below
  | { kind: "always" };                      // report every reading

export interface WatchReading {
  at: string;
  value: number;
}

export interface Watch {
  id: string;
  name: string;
  query_hint: string;
  cadence_hours: number;
  delta_policy: DeltaPolicy;
  readings: WatchReading[];
  created_at: string;
  last_checked?: string;
}

const MAX_READINGS = 30;
const MIN_BASELINE = 2;

export async function loadWatches(path: string): Promise<Watch[]> {
  const list = await readJsonSafe<Watch[]>(path, []);
  return Array.isArray(list) ? list : [];
}

export async function addWatch(
  path: string,
  spec: { name: string; query_hint: string; cadence_hours: number; delta_policy: DeltaPolicy }
): Promise<Watch> {
  const list = await loadWatches(path);
  if (list.some((w) => w.name.toLowerCase() === spec.name.toLowerCase())) {
    throw new Error(`A watch named "${spec.name}" already exists.`);
  }
  const watch: Watch = {
    id: randomUUID(),
    ...spec,
    readings: [],
    created_at: new Date().toISOString(),
  };
  await writeJsonAtomic(path, [...list, watch]);
  return watch;
}

export async function removeWatch(path: string, id: string): Promise<boolean> {
  const list = await loadWatches(path);
  const next = list.filter((w) => w.id !== id && w.name !== id);
  if (next.length === list.length) return false;
  await writeJsonAtomic(path, next);
  return true;
}

export async function dueWatches(path: string, now: Date = new Date()): Promise<Watch[]> {
  const list = await loadWatches(path);
  return list.filter((w) => {
    if (!w.last_checked) return true;
    const ageMs = now.getTime() - new Date(w.last_checked).getTime();
    return ageMs >= w.cadence_hours * 60 * 60 * 1000;
  });
}

export async function recordReading(path: string, id: string, value: number): Promise<void> {
  const list = await loadWatches(path);
  const idx = list.findIndex((w) => w.id === id);
  if (idx === -1) return;
  const w = list[idx]!;
  const updated: Watch = {
    ...w,
    readings: [...w.readings, { at: new Date().toISOString(), value }].slice(-MAX_READINGS),
    last_checked: new Date().toISOString(),
  };
  await writeJsonAtomic(path, list.map((x, i) => (i === idx ? updated : x)));
}

// Stamp a check without a reading (fetch failed) so the cadence still applies.
export async function markChecked(path: string, id: string): Promise<void> {
  const list = await loadWatches(path);
  const idx = list.findIndex((w) => w.id === id);
  if (idx === -1) return;
  await writeJsonAtomic(path, list.map((x, i) => (i === idx ? { ...x, last_checked: new Date().toISOString() } : x)));
}

export interface ReadingVerdict {
  notable: boolean;
  summary: string;
}

export function evaluateReading(value: number, history: WatchReading[], policy: DeltaPolicy): ReadingVerdict {
  if (policy.kind === "always") {
    return { notable: true, summary: `current value ${value}` };
  }
  if (policy.kind === "above") {
    return value > policy.threshold
      ? { notable: true, summary: `${value} crossed above the ${policy.threshold} threshold` }
      : { notable: false, summary: `${value} (under ${policy.threshold})` };
  }
  if (policy.kind === "below") {
    return value < policy.threshold
      ? { notable: true, summary: `${value} crossed below the ${policy.threshold} threshold` }
      : { notable: false, summary: `${value} (above ${policy.threshold})` };
  }
  // percent-vs-baseline: quiet until there's enough history to mean anything.
  if (history.length < MIN_BASELINE) {
    return { notable: false, summary: `${value} (building baseline, ${history.length}/${MIN_BASELINE})` };
  }
  const mean = history.reduce((sum, r) => sum + r.value, 0) / history.length;
  if (mean === 0) return { notable: value !== 0, summary: `${value} (baseline was zero)` };
  const deltaPct = ((value - mean) / Math.abs(mean)) * 100;
  const notable = Math.abs(deltaPct) >= policy.threshold;
  const direction = deltaPct >= 0 ? "above" : "below";
  return {
    notable,
    summary: `${value} — ${Math.abs(deltaPct).toFixed(0)}% ${direction} the recent baseline of ${mean.toFixed(1)}`,
  };
}

export function renderWatches(watches: Watch[]): string {
  if (watches.length === 0) {
    return "No watches configured. Add one with watch_metric, or via /sapience watches in chat.";
  }
  return watches.map((w) => {
    const latest = w.readings[w.readings.length - 1];
    const policy = w.delta_policy.kind === "always" ? "every reading"
      : w.delta_policy.kind === "percent" ? `±${w.delta_policy.threshold}% vs baseline`
      : `${w.delta_policy.kind} ${w.delta_policy.threshold}`;
    return `- ${w.name} (every ${w.cadence_hours}h, notify: ${policy})${latest ? ` — latest ${latest.value} at ${latest.at.slice(0, 16)}` : " — no readings yet"}`;
  }).join("\n");
}

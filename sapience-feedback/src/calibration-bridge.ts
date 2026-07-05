import { resolvePath } from "./utils.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";
import type { DetectedSignal } from "./types.js";

interface CalibrationEntry {
  domain: string;
  action_class: string;
  tier: "act" | "propose" | "ask" | "explore";
  confidence: number;
  confirmed_count: number;
  corrected_count: number;
  last_calibrated: string;
  notes: string;
}

async function loadProfile(path: string): Promise<CalibrationEntry[]> {
  return readJsonSafe<CalibrationEntry[]>(resolvePath(path), []);
}

async function saveProfile(profile: CalibrationEntry[], path: string): Promise<void> {
  await writeJsonAtomic(resolvePath(path), profile);
}

export type ApplyResult =
  | { status: "applied" | "created"; old_confidence: number; new_confidence: number; old_tier: string; new_tier: string }
  | { status: "noop" };

function applySignal(entry: CalibrationEntry, signal: DetectedSignal): CalibrationEntry | null {
  if (signal.type === "confirmation") {
    return { ...entry, confidence: Math.min(1, entry.confidence + 0.1), confirmed_count: entry.confirmed_count + 1, last_calibrated: new Date().toISOString() };
  }
  if (signal.type === "correction") {
    return { ...entry, confidence: Math.max(0, entry.confidence - 0.3), corrected_count: entry.corrected_count + 1, last_calibrated: new Date().toISOString() };
  }
  if (signal.type === "tier_adjustment" && signal.suggested_tier) {
    return { ...entry, tier: signal.suggested_tier, last_calibrated: new Date().toISOString() };
  }
  return null;
}

export async function applyFeedbackToProfile(signal: DetectedSignal, calibrationPath: string): Promise<ApplyResult> {
  const profile = await loadProfile(calibrationPath);
  const idx = profile.findIndex(e => e.domain === signal.domain && e.action_class === signal.action_class);

  if (idx >= 0) {
    const entry = profile[idx]!;
    const updated = applySignal(entry, signal);
    if (!updated) return { status: "noop" };
    await saveProfile(profile.map((e, i) => i === idx ? updated : e), calibrationPath);
    return { status: "applied", old_confidence: entry.confidence, new_confidence: updated.confidence, old_tier: entry.tier, new_tier: updated.tier };
  }

  // Feedback about a domain sapience hasn't routed yet used to be dropped
  // ("orphaned") — the correction never affected behavior. Seed a conservative
  // entry and apply the signal so early feedback isn't lost. Sapience's router
  // upserts with the same propose/0 baseline when it first sees a domain.
  const baseline: CalibrationEntry = {
    domain: signal.domain,
    action_class: signal.action_class,
    tier: "propose",
    confidence: 0,
    confirmed_count: 0,
    corrected_count: 0,
    last_calibrated: new Date().toISOString(),
    notes: "created from feedback",
  };
  const created = applySignal(baseline, signal);
  if (!created) return { status: "noop" };
  await saveProfile([...profile, created], calibrationPath);
  return { status: "created", old_confidence: baseline.confidence, new_confidence: created.confidence, old_tier: baseline.tier, new_tier: created.tier };
}

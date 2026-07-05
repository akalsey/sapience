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
  | { status: "applied"; old_confidence: number; new_confidence: number; old_tier: string; new_tier: string }
  | { status: "orphaned" }
  | { status: "noop" };

export async function applyFeedbackToProfile(signal: DetectedSignal, calibrationPath: string): Promise<ApplyResult> {
  const profile = await loadProfile(calibrationPath);
  if (profile.length === 0) return { status: "orphaned" };

  const idx = profile.findIndex(e => e.domain === signal.domain && e.action_class === signal.action_class);
  if (idx === -1) return { status: "orphaned" };

  const entry = profile[idx]!;
  let updated: CalibrationEntry;

  if (signal.type === "confirmation") {
    updated = { ...entry, confidence: Math.min(1, entry.confidence + 0.1), confirmed_count: entry.confirmed_count + 1, last_calibrated: new Date().toISOString() };
  } else if (signal.type === "correction") {
    updated = { ...entry, confidence: Math.max(0, entry.confidence - 0.3), corrected_count: entry.corrected_count + 1, last_calibrated: new Date().toISOString() };
  } else if (signal.type === "tier_adjustment" && signal.suggested_tier) {
    updated = { ...entry, tier: signal.suggested_tier, last_calibrated: new Date().toISOString() };
  } else {
    return { status: "noop" };
  }

  await saveProfile(profile.map((e, i) => i === idx ? updated : e), calibrationPath);
  return {
    status: "applied",
    old_confidence: entry.confidence,
    new_confidence: updated.confidence,
    old_tier: entry.tier,
    new_tier: updated.tier,
  };
}

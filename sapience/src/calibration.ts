import { resolvePath } from "./utils.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";
import type { CalibrationEntry, CalibrationProfile } from "./types.js";

export async function loadProfile(path: string): Promise<CalibrationProfile> {
  return readJsonSafe<CalibrationProfile>(resolvePath(path), []);
}

export async function saveProfile(profile: CalibrationProfile, path: string): Promise<void> {
  await writeJsonAtomic(resolvePath(path), profile);
}

// Merge helper for the routing loop: sapience only ever ADDS entries (never
// modifies existing ones), so merging against a freshly loaded profile keeps
// it from clobbering confidence changes sapience-feedback wrote mid-run.
export function addMissingEntries(current: CalibrationProfile, additions: CalibrationProfile): CalibrationProfile {
  const missing = additions.filter(
    a => !current.some(e => e.domain === a.domain && e.action_class === a.action_class)
  );
  return missing.length === 0 ? current : [...current, ...missing];
}

// Trust should not linger: confidence earned months ago and never reinforced
// decays toward the uncalibrated default with a 90-day half-life. This is a
// computed VIEW applied at routing time — the stored profile keeps the raw
// values so reinforcement history is never destroyed.
export function decayProfile(
  profile: CalibrationProfile,
  now: Date = new Date(),
  halfLifeDays = 90
): CalibrationProfile {
  return profile.map((e) => {
    const ageMs = now.getTime() - new Date(e.last_calibrated).getTime();
    if (!Number.isFinite(ageMs) || ageMs <= 0) return { ...e };
    const factor = Math.pow(0.5, ageMs / (halfLifeDays * 24 * 60 * 60 * 1000));
    return { ...e, confidence: e.confidence * factor };
  });
}

export function getEntry(
  profile: CalibrationProfile,
  domain: string,
  action_class: string
): CalibrationEntry | null {
  return profile.find(e => e.domain === domain && e.action_class === action_class) ?? null;
}

export function needsCalibration(entry: CalibrationEntry | null, threshold: number): boolean {
  return !entry || entry.confidence < threshold;
}

export function upsertEntry(
  profile: CalibrationProfile,
  domain: string,
  action_class: string,
  update: Partial<CalibrationEntry>
): CalibrationProfile {
  const idx = profile.findIndex(e => e.domain === domain && e.action_class === action_class);
  const base: CalibrationEntry = idx === -1
    ? {
        domain, action_class, tier: "propose", confidence: 0,
        confirmed_count: 0, corrected_count: 0,
        last_calibrated: new Date().toISOString(), notes: "",
      }
    : profile[idx]!;
  const updated = { ...base, ...update, last_calibrated: new Date().toISOString() };
  if (idx === -1) return [...profile, updated];
  return profile.map((e, i) => i === idx ? updated : e);
}

export function applyConfirmation(entry: CalibrationEntry): CalibrationEntry {
  return {
    ...entry,
    confidence: Math.min(1, entry.confidence + 0.1),
    confirmed_count: entry.confirmed_count + 1,
    last_calibrated: new Date().toISOString(),
  };
}

export function applyCorrection(
  entry: CalibrationEntry,
  newTier: CalibrationEntry["tier"]
): CalibrationEntry {
  return {
    ...entry,
    tier: newTier,
    confidence: Math.max(0, entry.confidence - 0.3),
    corrected_count: entry.corrected_count + 1,
    last_calibrated: new Date().toISOString(),
  };
}

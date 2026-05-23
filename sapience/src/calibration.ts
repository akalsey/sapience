import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { resolvePath } from "./utils.js";
import type { CalibrationEntry, CalibrationProfile } from "./types.js";

export async function loadProfile(path: string): Promise<CalibrationProfile> {
  try {
    return JSON.parse(await readFile(resolvePath(path), "utf-8")) as CalibrationProfile;
  } catch { return []; }
}

export async function saveProfile(profile: CalibrationProfile, path: string): Promise<void> {
  const resolved = resolvePath(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(profile, null, 2), "utf-8");
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

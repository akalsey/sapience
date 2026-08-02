import { join } from "path";
import { loadOutcomes, saveOutcomes, resolveProposal } from "./outcome-tracker.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";
import { dropStaleQueuedDeliveries } from "./stale-deliveries.js";
import type { OutcomeRecord } from "./types.js";

export type RecordableOutcome = "acted_on" | "accepted" | "rejected" | "acknowledged";

export const RECORDABLE_OUTCOMES: readonly RecordableOutcome[] = ["acted_on", "accepted", "rejected", "acknowledged"];

interface CalibrationEntry {
  domain: string;
  action_class: string;
  tier: string;
  confidence: number;
  confirmed_count: number;
  corrected_count: number;
  last_calibrated: string;
  notes: string;
}

// Outcomes move calibration confidence too: the user acting on a proposal is
// the strongest confirmation signal there is, and a dismissal is a mild
// correction (weaker than an explicit "don't do that", hence ±0.1 vs
// feedback's -0.3). The calibration file is sapience's, written here by the
// same workspace convention sapience-feedback already uses.
async function adjustCalibration(
  workspaceDir: string,
  outcome: RecordableOutcome,
  domain: string,
  actionClass: string
): Promise<void> {
  if (outcome === "acknowledged") return;
  const path = join(workspaceDir, "sapience", "calibration.json");
  const profile = await readJsonSafe<CalibrationEntry[]>(path, []);
  const idx = profile.findIndex((e) => e.domain === domain && e.action_class === actionClass);
  const entry: CalibrationEntry = idx >= 0 ? profile[idx]! : {
    domain, action_class: actionClass, tier: "propose",
    confidence: 0, confirmed_count: 0, corrected_count: 0,
    last_calibrated: new Date().toISOString(), notes: "created from outcome",
  };
  const positive = outcome === "acted_on" || outcome === "accepted";
  const updated: CalibrationEntry = {
    ...entry,
    confidence: positive ? Math.min(1, entry.confidence + 0.1) : Math.max(0, entry.confidence - 0.1),
    confirmed_count: entry.confirmed_count + (positive ? 1 : 0),
    corrected_count: entry.corrected_count + (positive ? 0 : 1),
    last_calibrated: new Date().toISOString(),
  };
  const next = idx >= 0 ? profile.map((e, i) => (i === idx ? updated : e)) : [...profile, updated];
  await writeJsonAtomic(path, next);
}

export interface RecordOutcomeParams {
  proposalId: string;
  outcome: RecordableOutcome;
  domain?: string;
  actionClass?: string;
}

export interface RecordOutcomeResult {
  ok: boolean;
  message: string;
  record?: OutcomeRecord;
  // Queued deliveries retired because this answer settled them.
  staleDropped?: string[];
}

export async function recordOutcome(
  trackerPath: string,
  workspaceDir: string,
  params: RecordOutcomeParams
): Promise<RecordOutcomeResult> {
  const outcomes = await loadOutcomes(trackerPath);
  const existing = outcomes[params.proposalId];
  if (!existing || existing.state !== "pending") {
    return { ok: false, message: `No pending proposal with id "${params.proposalId}".` };
  }
  const updated = resolveProposal(outcomes, params.proposalId, params.outcome);
  await saveOutcomes(updated, trackerPath);
  if (params.domain && params.actionClass) {
    await adjustCalibration(workspaceDir, params.outcome, params.domain, params.actionClass);
  }
  // The user has now spoken about this. Anything still queued from the same
  // thought would arrive minutes later re-asking what they just settled, so it
  // is retired here rather than delivered. Never fatal: a queue that cannot be
  // read or written must not cost the user their recorded outcome.
  const staleDropped = await dropStaleQueuedDeliveries(
    join(workspaceDir, "sapience", "pending-deliveries.json"),
    updated,
    params.proposalId
  ).catch(() => [] as string[]);
  return {
    ok: true,
    message: `Recorded ${params.outcome} for ${params.proposalId}.`,
    record: updated[params.proposalId],
    staleDropped,
  };
}

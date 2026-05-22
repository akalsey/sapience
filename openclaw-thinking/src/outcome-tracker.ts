import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { OutcomeMap, OutcomeRecord, ProposalSet, ProposalType } from "./types.js";

export async function loadOutcomes(trackerPath: string): Promise<OutcomeMap> {
  try {
    return JSON.parse(await readFile(trackerPath, "utf-8")) as OutcomeMap;
  } catch {
    return {};
  }
}

export async function saveOutcomes(outcomes: OutcomeMap, trackerPath: string): Promise<void> {
  await mkdir(dirname(trackerPath), { recursive: true });
  await writeFile(trackerPath, JSON.stringify(outcomes, null, 2), "utf-8");
}

export function addProposals(outcomes: OutcomeMap, proposals: ProposalSet): OutcomeMap {
  const updated = { ...outcomes };
  const now = new Date().toISOString();

  const add = (id: string, type: ProposalType) => {
    if (!updated[id]) {
      updated[id] = { proposal_id: id, proposal_type: type, pass_id: proposals.pass_id, created_at: now, state: "pending" };
    }
  };

  for (const o of proposals.observations) add(o.id, "observation");
  for (const a of proposals.proposed_actions) add(a.id, "action");
  for (const a of proposals.proposed_audits) add(a.id, "audit");
  for (const q of proposals.open_questions) add(q.id, "question");

  return updated;
}

export function expireOldProposals(outcomes: OutcomeMap, expiryDays = 7): OutcomeMap {
  const updated = { ...outcomes };
  const cutoff = Date.now() - expiryDays * 24 * 60 * 60 * 1000;
  for (const [id, r] of Object.entries(updated)) {
    if (r.state === "pending" && new Date(r.created_at).getTime() < cutoff) {
      updated[id] = { ...r, state: "expired", resolved_at: new Date().toISOString() };
    }
  }
  return updated;
}

export function resolveProposal(
  outcomes: OutcomeMap,
  id: string,
  state: Exclude<OutcomeRecord["state"], "pending" | "expired">
): OutcomeMap {
  if (!outcomes[id]) throw new Error(`Proposal ${id} not found`);
  return { ...outcomes, [id]: { ...outcomes[id], state, resolved_at: new Date().toISOString() } };
}

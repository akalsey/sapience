import type { OutcomeMap, OutcomeRecord, ProposalSet, ProposalType } from "./types.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

export async function loadOutcomes(trackerPath: string): Promise<OutcomeMap> {
  return readJsonSafe<OutcomeMap>(trackerPath, {});
}

export async function saveOutcomes(outcomes: OutcomeMap, trackerPath: string): Promise<void> {
  await writeJsonAtomic(trackerPath, outcomes);
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

// expireOldProposals only marks entries; without a purge the map grew forever
// and was rewritten in full every pass. Pending entries are never purged —
// they still expire first.
export function purgeResolvedOutcomes(outcomes: OutcomeMap, retentionDays = 30): OutcomeMap {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const kept: OutcomeMap = {};
  for (const [id, r] of Object.entries(outcomes)) {
    if (r.state === "pending" || new Date(r.created_at).getTime() >= cutoff) kept[id] = r;
  }
  return kept;
}

export function resolveProposal(
  outcomes: OutcomeMap,
  id: string,
  state: Exclude<OutcomeRecord["state"], "pending" | "expired">
): OutcomeMap {
  if (!outcomes[id]) throw new Error(`Proposal ${id} not found`);
  return { ...outcomes, [id]: { ...outcomes[id], state, resolved_at: new Date().toISOString() } };
}

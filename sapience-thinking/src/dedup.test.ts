import { describe, it, expect } from "vitest";
import { similarity, dedupeProposals } from "./dedup.js";
import type { OutcomeMap, ProposalSet } from "./types.js";

const basePass: ProposalSet = {
  pass_id: "pass-9",
  timestamp: new Date().toISOString(),
  nothing_to_report: false,
  summary: "s",
  observations: [],
  proposed_actions: [],
  proposed_audits: [],
  open_questions: [],
};

function outcome(id: string, text: string, state: string, daysAgo = 1): OutcomeMap[string] {
  return {
    proposal_id: id,
    proposal_type: "action",
    pass_id: "pass-1",
    created_at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    state: state as any,
    text,
  };
}

describe("similarity", () => {
  it("scores near-identical phrasings high and unrelated text low", () => {
    expect(similarity(
      "Set up a weekly export of the PostHog activation funnel",
      "Set up the weekly PostHog activation funnel export"
    )).toBeGreaterThan(0.6);
    expect(similarity(
      "Set up a weekly export of the PostHog activation funnel",
      "Investigate duplicate Salesforce accounts for Apple"
    )).toBeLessThan(0.3);
  });
});

describe("dedupeProposals", () => {
  // The only repeat-guard was "last 3 passes in the prompt". A proposal the
  // user dismissed two days ago could resurface on pass four — the fastest
  // way to teach the user to ignore the suite.
  it("drops proposals near-identical to recently rejected ones", () => {
    const outcomes: OutcomeMap = {
      "old-1": outcome("old-1", "Set up a weekly export of the PostHog activation funnel", "rejected", 2),
    };
    const pass: ProposalSet = {
      ...basePass,
      proposed_actions: [
        { id: "new-1", text: "Set up the weekly PostHog activation funnel export", rationale: "", estimated_effort: "small", priority: 3 },
        { id: "new-2", text: "Audit stale Salesforce contacts", rationale: "", estimated_effort: "small", priority: 3 },
      ],
    };
    const { kept, dropped } = dedupeProposals(pass, outcomes);
    expect(dropped).toBe(1);
    expect(kept.proposed_actions.map((a) => a.id)).toEqual(["new-2"]);
  });

  it("drops duplicates of still-pending proposals (already in flight)", () => {
    const outcomes: OutcomeMap = {
      "old-1": outcome("old-1", "Investigate the voice minutes spike", "pending", 1),
    };
    const pass: ProposalSet = {
      ...basePass,
      observations: [{ id: "new-1", text: "Investigate the voice minutes spike", evidence: "", priority: 3 }],
    };
    expect(dedupeProposals(pass, outcomes).kept.observations).toHaveLength(0);
  });

  it("allows repeats once the memory window has passed", () => {
    const outcomes: OutcomeMap = {
      "old-1": outcome("old-1", "Set up a weekly export of the PostHog activation funnel", "rejected", 30),
    };
    const pass: ProposalSet = {
      ...basePass,
      proposed_actions: [{ id: "new-1", text: "Set up a weekly export of the PostHog activation funnel", rationale: "", estimated_effort: "small", priority: 3 }],
    };
    expect(dedupeProposals(pass, outcomes, { windowDays: 14 }).kept.proposed_actions).toHaveLength(1);
  });

  it("ignores history records without text (pre-upgrade outcomes)", () => {
    const outcomes: OutcomeMap = {
      "old-1": { ...outcome("old-1", "", "rejected", 1), text: undefined },
    };
    const pass: ProposalSet = {
      ...basePass,
      proposed_actions: [{ id: "new-1", text: "Anything at all", rationale: "", estimated_effort: "small", priority: 3 }],
    };
    expect(dedupeProposals(pass, outcomes).kept.proposed_actions).toHaveLength(1);
  });

  it("dedupes across all proposal kinds", () => {
    const outcomes: OutcomeMap = {
      "old-1": outcome("old-1", "The auth domain has no scheduled audit coverage", "expired", 3),
    };
    const pass: ProposalSet = {
      ...basePass,
      proposed_audits: [{ id: "new-1", domain: "auth", rationale: "no scheduled audit coverage for the auth domain", priority: 2 }],
    };
    expect(dedupeProposals(pass, outcomes).kept.proposed_audits).toHaveLength(0);
  });
});

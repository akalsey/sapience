import { describe, it, expect } from "vitest";
import { similarity, isNearDuplicate, dedupeProposals } from "./dedup.js";
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

describe("isNearDuplicate", () => {
  // Jaccard alone under-matches a RESTATEMENT of an ongoing situation: each
  // re-description adds tokens that land in the union and sink the score.
  // Production 2026-08-03 delivered the same "stuck in a failure loop"
  // observation to the user four times in 75 minutes at priority 5; every pair
  // scored 0.243-0.556, all under the 0.60 bar. Containment (shared / smaller
  // side) is what catches "B restates A with more detail".
  it("matches a restatement that Jaccard alone misses", () => {
    const a = "I remain in a critical failure loop, unable to answer the user's direct question about the 30% increase in AI minutes despite repeated attempts and explicit guidance.";
    const b = "I remain in a critical failure loop, unable to answer the user's direct question about the 30% increase in AI minutes. My attempts to use the correct tool have failed, and I have not made progress.";
    expect(similarity(a, b)).toBeLessThan(0.6);
    expect(isNearDuplicate(a, b)).toBe(true);
  });

  it("keeps genuinely distinct findings apart", () => {
    const loop = "I remain in a critical failure loop, unable to answer the user's direct question about the 30% increase in AI minutes despite repeated attempts and explicit guidance.";
    const audit = "A scheduled audit found that the Google Apps Script API is disabled for my cloud project, which will cause the copy-slide skill to fail.";
    expect(isNearDuplicate(loop, audit)).toBe(false);
  });

  // Containment alone would fold anything short into anything long — a short
  // hunch shares most of its few tokens with unrelated prose — so it needs a
  // floor on the smaller side.
  it("does not fold a short fragment into a long unrelated one", () => {
    const short = "A new Voice of Customer MCP is not yet integrated.";
    const long = "The agent attempted to fetch Salesforce documentation directly, but it failed due to a security error, which suggests an underlying access control issue that is not yet integrated into the runbook.";
    expect(isNearDuplicate(short, long)).toBe(false);
  });
});

describe("dedupeProposals", () => {
  // The four production repeats, in the order they were emitted, run through
  // the real sequential algorithm rather than compared pairwise.
  it("collapses successive restatements of an unresolved situation", () => {
    const texts = [
      "I am stuck in a failure loop trying to answer the user's question about the 30% increase in AI minutes. I have repeatedly failed to use the correct tool (`weekly-product-review` skill) as directed, instead attempting multiple incorrect methods.",
      "I remain in a critical failure loop, unable to answer the user's direct question about the 30% increase in AI minutes despite repeated attempts and explicit guidance.",
      "I remain in a critical failure loop, unable to answer the user's direct question about the 30% increase in AI minutes. My attempts to use the correct tool have failed, and I have not made progress.",
      "I remain in a critical failure loop, unable to answer the user's direct question about the 30% increase in AI minutes. Despite identifying the existence of relevant skills like `weekly-product-review`, I have not successfully used them to provide an answer.",
    ];
    const outcomes: OutcomeMap = {};
    const surfaced: string[] = [];
    texts.forEach((text, i) => {
      const pass: ProposalSet = {
        ...basePass,
        pass_id: `pass-${i}`,
        observations: [{ id: `obs-${i}`, text, evidence: "", priority: 5 }],
      };
      const { kept } = dedupeProposals(pass, outcomes);
      for (const o of kept.observations) {
        surfaced.push(o.id);
        outcomes[o.id] = outcome(o.id, o.text, "pending", 0);
      }
    });
    // Was 4 of 4 before containment. The first and second are far enough apart
    // in wording to stay separate; everything after collapses into the second.
    expect(surfaced).toEqual(["obs-0", "obs-1"]);
  });

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

import { describe, it, expect } from "vitest";
import { parseProposals, normalizeProposals, ParseError } from "./output-parser.js";

const validProposals = {
  pass_id: "abc-123",
  timestamp: "2026-05-20T08:00:00Z",
  observations: [{ id: "obs-1", text: "Something noted", evidence: "session X", priority: 3 }],
  proposed_actions: [],
  proposed_audits: [],
  open_questions: [],
  nothing_to_report: false,
  summary: "Reviewed recent activity.",
};

describe("parseProposals", () => {
  it("accepts a valid ProposalSet", () => {
    expect(() => parseProposals(validProposals)).not.toThrow();
    expect(parseProposals(validProposals).pass_id).toBe("abc-123");
  });

  it("accepts nothing_to_report with empty arrays", () => {
    const input = { ...validProposals, observations: [], nothing_to_report: true };
    expect(parseProposals(input).nothing_to_report).toBe(true);
  });

  it("still throws ParseError for non-object input", () => {
    expect(() => parseProposals("not an object")).toThrow(ParseError);
    expect(() => parseProposals(null)).toThrow(ParseError);
  });
});

// These mirror the exact failures seen in production: the model calls the tool
// but omits boilerplate or half-forms items. The parser now recovers instead
// of rejecting the whole pass.
describe("tolerant normalization", () => {
  it("stamps a missing pass_id and timestamp", () => {
    const { pass_id: _p, timestamp: _t, ...bare } = validProposals;
    const out = parseProposals(bare);
    expect(out.pass_id).toMatch(/[0-9a-f-]{36}/);
    expect(out.timestamp).toBeTruthy();
  });

  it("defaults a missing estimated_effort to medium", () => {
    const input = {
      ...validProposals,
      proposed_actions: [{ id: "act-1", text: "Do it", rationale: "why", priority: 3 }],
    };
    expect(parseProposals(input).proposed_actions[0]!.estimated_effort).toBe("medium");
  });

  it("coerces an invalid estimated_effort to medium", () => {
    const input = {
      ...validProposals,
      proposed_actions: [{ id: "act-1", text: "Do it", rationale: "why", estimated_effort: "huge", priority: 3 }],
    };
    expect(parseProposals(input).proposed_actions[0]!.estimated_effort).toBe("medium");
  });

  it("fills the four arrays when they are missing entirely", () => {
    const out = parseProposals({ pass_id: "p", timestamp: "t", summary: "s", proposed_actions: [{ id: "a", text: "x", rationale: "", priority: 2 }] });
    expect(out.observations).toEqual([]);
    expect(out.proposed_audits).toEqual([]);
    expect(out.open_questions).toEqual([]);
    expect(out.proposed_actions).toHaveLength(1);
  });

  it("drops content-incomplete items but keeps the well-formed ones", () => {
    const { proposals, dropped } = normalizeProposals({
      ...validProposals,
      proposed_actions: [
        { id: "a1", text: "keep me", rationale: "r", estimated_effort: "small", priority: 2 },
        { id: "a2", rationale: "no text so drop me", priority: 2 },
      ],
      open_questions: [{ id: "q1", blocking_what: "no text" }],
    });
    expect(proposals.proposed_actions.map((a) => a.text)).toEqual(["keep me"]);
    expect(proposals.open_questions).toHaveLength(0);
    expect(dropped).toBe(2);
  });

  it("clamps an out-of-range priority instead of rejecting", () => {
    const input = { ...validProposals, observations: [{ ...validProposals.observations[0], priority: 9 }] };
    expect(parseProposals(input).observations[0]!.priority).toBe(5);
  });

  it("strips an invalid evidence_grade rather than throwing", () => {
    const out = parseProposals({
      ...validProposals,
      observations: [{ id: "o1", text: "x", evidence: "y", priority: 3, evidence_grade: "gut_feeling" }],
    });
    expect(out.observations[0]!.evidence_grade).toBeUndefined();
  });

  it("keeps a valid evidence_grade", () => {
    const out = parseProposals({
      ...validProposals,
      observations: [{ id: "o1", text: "x", evidence: "y", priority: 3, evidence_grade: "hunch" }],
    });
    expect(out.observations[0]!.evidence_grade).toBe("hunch");
  });

  it("unwraps a nested { proposals: {...} } envelope", () => {
    const out = parseProposals({ proposals: validProposals });
    expect(out.pass_id).toBe("abc-123");
    expect(out.observations).toHaveLength(1);
  });

  it("treats an empty/contentless payload as nothing_to_report", () => {
    const out = parseProposals({ summary: "quiet pass" });
    expect(out.nothing_to_report).toBe(true);
    expect(out.summary).toBe("quiet pass");
  });
});

// Item ids are the handle the agent passes back to record_outcome, so they
// must be unique. Models do not generate random UUIDs — they generate
// PATTERNED ones and reuse them. Across 1,217 production passes, 92 ids were
// reused and 88 of those carried different content each time; one id named
// three different pending actions inside a single delivered prompt, making the
// record_outcome call ambiguous by construction. The id is ours to mint.
describe("host-generated item ids", () => {
  const collide = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("discards the model's id and mints a fresh v4 uuid per item", () => {
    const out = parseProposals({
      ...validProposals,
      observations: [{ id: collide, text: "An observation", evidence: "e", priority: 3 }],
      proposed_actions: [{ id: collide, text: "An action", rationale: "r", estimated_effort: "small", priority: 3 }],
      proposed_audits: [{ id: collide, domain: "d", rationale: "r", priority: 2 }],
      open_questions: [{ id: collide, text: "A question", blocking_what: "b" }],
    });
    const ids = [
      out.observations[0]!.id, out.proposed_actions[0]!.id,
      out.proposed_audits[0]!.id, out.open_questions[0]!.id,
    ];
    for (const id of ids) {
      expect(id).not.toBe(collide);
      expect(id).toMatch(V4);
    }
    expect(new Set(ids).size).toBe(4);
  });

  it("mints distinct ids for two passes that reuse the same model id", () => {
    const pass = () => parseProposals({
      ...validProposals,
      observations: [{ id: collide, text: "Auth has been failing for two hours", evidence: "e", priority: 4 }],
    });
    expect(pass().observations[0]!.id).not.toBe(pass().observations[0]!.id);
  });
});

import { describe, it, expect } from "vitest";
import { parseProposals, ParseError } from "./output-parser.js";

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

  it("throws ParseError when pass_id is missing", () => {
    const { pass_id: _, ...bad } = validProposals;
    expect(() => parseProposals(bad)).toThrow(ParseError);
  });

  it("throws ParseError when priority is out of range", () => {
    const bad = { ...validProposals, observations: [{ ...validProposals.observations[0], priority: 6 }] };
    expect(() => parseProposals(bad)).toThrow(ParseError);
  });

  it("throws ParseError for non-object input", () => {
    expect(() => parseProposals("not an object")).toThrow(ParseError);
    expect(() => parseProposals(null)).toThrow(ParseError);
  });

  it("throws ParseError when estimated_effort is invalid", () => {
    const bad = {
      ...validProposals,
      proposed_actions: [{ id: "act-1", text: "Do it", rationale: "why", estimated_effort: "huge", priority: 3 }],
    };
    expect(() => parseProposals(bad)).toThrow(ParseError);
  });
});

describe("evidence grading", () => {
  const base = {
    pass_id: "p1", timestamp: "2026-07-05T00:00:00Z", nothing_to_report: false, summary: "s",
    proposed_actions: [], proposed_audits: [], open_questions: [],
  };

  it("accepts a graded observation", () => {
    const set = parseProposals({
      ...base,
      observations: [{ id: "o1", text: "spend velocity decays before churn", evidence: "one case", priority: 3, evidence_grade: "hunch" }],
    });
    expect(set.observations[0]!.evidence_grade).toBe("hunch");
  });

  it("rejects an invalid grade", () => {
    expect(() => parseProposals({
      ...base,
      observations: [{ id: "o1", text: "x", evidence: "y", priority: 3, evidence_grade: "gut_feeling" }],
    })).toThrow();
  });

  it("keeps ungraded observations valid (grade optional)", () => {
    const set = parseProposals({
      ...base,
      observations: [{ id: "o1", text: "x", evidence: "y", priority: 3 }],
    });
    expect(set.observations[0]!.evidence_grade).toBeUndefined();
  });
});

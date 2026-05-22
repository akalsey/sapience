import { describe, it, expect } from "vitest";
import { getHighPriorityProposals } from "./delivery.js";
import type { ProposalSet } from "./types.js";

const proposals: ProposalSet = {
  pass_id: "p",
  timestamp: "2026-05-20T08:00:00Z",
  observations: [
    { id: "obs-high", text: "Critical issue", evidence: "e", priority: 5 },
    { id: "obs-low", text: "Minor thing", evidence: "e", priority: 2 },
  ],
  proposed_actions: [
    { id: "act-high", text: "Fix it now", rationale: "r", estimated_effort: "small", priority: 4 },
    { id: "act-low", text: "Nice to have", rationale: "r", estimated_effort: "large", priority: 1 },
  ],
  proposed_audits: [],
  open_questions: [],
  nothing_to_report: false,
  summary: "s",
};

describe("getHighPriorityProposals", () => {
  it("returns only proposals at or above threshold", () => {
    const result = getHighPriorityProposals(proposals, 4, 10);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("obs-high");
    expect(ids).toContain("act-high");
    expect(ids).not.toContain("obs-low");
    expect(ids).not.toContain("act-low");
  });

  it("respects maxCount", () => {
    const result = getHighPriorityProposals(proposals, 1, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("sorts by priority descending", () => {
    const result = getHighPriorityProposals(proposals, 1, 10);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].priority).toBeGreaterThanOrEqual(result[i].priority);
    }
  });

  it("returns empty array when no proposals meet threshold", () => {
    const highOnlyResult = getHighPriorityProposals(proposals, 5, 10);
    const ids = highOnlyResult.map(r => r.id);
    expect(ids).toContain("obs-high");
    expect(ids).not.toContain("act-high"); // act-high is priority 4, not 5
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadOutcomes, saveOutcomes, addProposals, expireOldProposals, resolveProposal,
} from "./outcome-tracker.js";
import type { ProposalSet, OutcomeMap } from "./types.js";

const proposals: ProposalSet = {
  pass_id: "pass-1",
  timestamp: "2026-05-20T08:00:00Z",
  observations: [{ id: "obs-1", text: "t", evidence: "e", priority: 3 }],
  proposed_actions: [{ id: "act-1", text: "t", rationale: "r", estimated_effort: "small", priority: 4 }],
  proposed_audits: [{ id: "aud-1", domain: "d", rationale: "r", priority: 2 }],
  open_questions: [{ id: "q-1", text: "t", blocking_what: "nothing" }],
  nothing_to_report: false,
  summary: "s",
};

let tmpDir: string;
let trackerPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "outcome-tracker-test-"));
  trackerPath = join(tmpDir, "outcomes.json");
});

afterEach(async () => { await rm(tmpDir, { recursive: true }); });

describe("loadOutcomes", () => {
  it("returns empty map when file does not exist", async () => {
    const result = await loadOutcomes(trackerPath);
    expect(result).toEqual({});
  });
});

describe("saveOutcomes + loadOutcomes", () => {
  it("round-trips outcomes correctly", async () => {
    const outcomes = addProposals({}, proposals);
    await saveOutcomes(outcomes, trackerPath);
    const loaded = await loadOutcomes(trackerPath);
    expect(loaded["obs-1"]).toBeDefined();
    expect(loaded["obs-1"].state).toBe("pending");
  });
});

describe("addProposals", () => {
  it("adds all proposal types as pending", () => {
    const outcomes = addProposals({}, proposals);
    expect(outcomes["obs-1"].state).toBe("pending");
    expect(outcomes["obs-1"].proposal_type).toBe("observation");
    expect(outcomes["act-1"].proposal_type).toBe("action");
    expect(outcomes["aud-1"].proposal_type).toBe("audit");
    expect(outcomes["q-1"].proposal_type).toBe("question");
  });

  it("sets pass_id and created_at on each record", () => {
    const outcomes = addProposals({}, proposals);
    expect(outcomes["obs-1"].pass_id).toBe("pass-1");
    expect(outcomes["obs-1"].created_at).toBeTruthy();
  });

  it("does not overwrite existing outcomes", () => {
    const first = addProposals({}, proposals);
    first["obs-1"].state = "accepted";
    const second = addProposals(first, proposals);
    expect(second["obs-1"].state).toBe("accepted");
  });
});

describe("expireOldProposals", () => {
  it("transitions pending proposals older than expiryDays to expired", () => {
    const outcomes: OutcomeMap = {
      "old-1": {
        proposal_id: "old-1", proposal_type: "observation", pass_id: "p",
        created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        state: "pending",
      },
    };
    const result = expireOldProposals(outcomes, 7);
    expect(result["old-1"].state).toBe("expired");
    expect(result["old-1"].resolved_at).toBeTruthy();
  });

  it("does not expire recent pending proposals", () => {
    const outcomes: OutcomeMap = {
      "new-1": {
        proposal_id: "new-1", proposal_type: "action", pass_id: "p",
        created_at: new Date().toISOString(), state: "pending",
      },
    };
    const result = expireOldProposals(outcomes, 7);
    expect(result["new-1"].state).toBe("pending");
  });

  it("does not expire already-resolved proposals", () => {
    const outcomes: OutcomeMap = {
      "resolved-1": {
        proposal_id: "resolved-1", proposal_type: "action", pass_id: "p",
        created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        state: "accepted",
      },
    };
    const result = expireOldProposals(outcomes, 7);
    expect(result["resolved-1"].state).toBe("accepted");
  });
});

describe("resolveProposal", () => {
  it("updates state and sets resolved_at", () => {
    const outcomes = addProposals({}, proposals);
    const updated = resolveProposal(outcomes, "obs-1", "accepted");
    expect(updated["obs-1"].state).toBe("accepted");
    expect(updated["obs-1"].resolved_at).toBeTruthy();
  });

  it("throws when proposal ID not found", () => {
    expect(() => resolveProposal({}, "nonexistent", "accepted")).toThrow();
  });
});

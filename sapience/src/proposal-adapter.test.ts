import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { extractDomain, proposalSetToItems, readUnprocessedPasses } from "./proposal-adapter.js";
import type { ProposalSet } from "./proposal-adapter.js";

describe("extractDomain", () => {
  it("extracts github", () => expect(extractDomain("open a GitHub PR")).toBe("github"));
  it("extracts posthog", () => expect(extractDomain("PostHog funnel analysis")).toBe("posthog"));
  it("extracts salesforce", () => expect(extractDomain("Salesforce contact query")).toBe("salesforce"));
  it("extracts slides for deck", () => expect(extractDomain("update the deck slides")).toBe("slides"));
  it("defaults to general", () => expect(extractDomain("something vague")).toBe("general"));
});

const sampleSet: ProposalSet = {
  pass_id: "pass-1", timestamp: "2026-05-20T10:00:00Z",
  nothing_to_report: false,
  summary: "test pass",
  observations: [{ id: "obs-1", text: "GitHub PR queue is long", evidence: "saw 12 PRs", priority: 3 }],
  proposed_actions: [{ id: "act-1", text: "Review GitHub PRs", rationale: "queue blocking team", estimated_effort: "small", priority: 4 }],
  proposed_audits: [{ id: "aud-1", domain: "PostHog events", rationale: "no audit scheduled", priority: 2 }],
  open_questions: [{ id: "q-1", text: "Should I update Salesforce records?", blocking_what: "data sync" }],
};

describe("proposalSetToItems", () => {
  it("converts observations with correct domain", () => {
    const items = proposalSetToItems(sampleSet);
    const obs = items.find(i => i.id === "obs-1")!;
    expect(obs.type).toBe("observation");
    expect(obs.domain).toBe("github");
    expect(obs.action_class).toBe("observation");
  });

  it("converts proposed_actions with domain-scoped action_class", () => {
    const items = proposalSetToItems(sampleSet);
    const act = items.find(i => i.id === "act-1")!;
    expect(act.type).toBe("action");
    expect(act.domain).toBe("github");
    expect(act.action_class).toBe("github/action");
  });

  it("converts proposed_audits", () => {
    const items = proposalSetToItems(sampleSet);
    const aud = items.find(i => i.id === "aud-1")!;
    expect(aud.type).toBe("audit");
    expect(aud.domain).toBe("posthog");
    expect(aud.action_class).toBe("posthog/audit");
  });

  it("converts open_questions with default priority 3", () => {
    const items = proposalSetToItems(sampleSet);
    const q = items.find(i => i.id === "q-1")!;
    expect(q.type).toBe("question");
    expect(q.priority).toBe(3);
  });

  it("returns empty array for nothing_to_report passes", () => {
    expect(proposalSetToItems({ ...sampleSet, nothing_to_report: true })).toHaveLength(0);
  });
});

describe("readUnprocessedPasses", () => {

  function pass(id: string): string {
    return JSON.stringify({ pass_id: id, timestamp: `2026-06-0${id.slice(-1)}T10:00:00Z`, nothing_to_report: false, summary: "", observations: [], proposed_actions: [], proposed_audits: [], open_questions: [] });
  }

  it("skips passes that precede the last processed pass in file order (evicted ids stay processed)", async () => {
    // processed-passes caps its id set; ids evicted from the set must not be
    // re-routed. proposals.jsonl is append-only, so anything before the last
    // in-set pass has already been processed.
    const dir = await mkdtemp(join(tmpdir(), "adapter-"));
    const path = join(dir, "proposals.jsonl");
    await writeFile(path, [pass("pass-1"), pass("pass-2"), pass("pass-3")].join("\n") + "\n");
    const result = await readUnprocessedPasses(path, new Set(["pass-2"]));
    expect(result.map(p => p.pass_id)).toEqual(["pass-3"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("returns all passes when none are in the processed set (fresh install path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapter-"));
    const path = join(dir, "proposals.jsonl");
    await writeFile(path, [pass("pass-1"), pass("pass-2")].join("\n") + "\n");
    const result = await readUnprocessedPasses(path, new Set());
    expect(result.map(p => p.pass_id)).toEqual(["pass-1", "pass-2"]);
    await rm(dir, { recursive: true, force: true });
  });
});

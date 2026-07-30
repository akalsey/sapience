import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadHypotheses, noteSighting, recordVerdict } from "./hypotheses.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hypotheses-"));
  path = join(dir, "hypotheses.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const hunch = { id: "p1", text: "spend velocity decays before churn across customers", domain: "posthog" };

describe("noteSighting", () => {
  it("creates a new open hypothesis on first sighting", async () => {
    const h = await noteSighting(path, hunch);
    expect(h.status).toBe("open");
    expect(h.sightings).toBe(1);
    const stored = await loadHypotheses(path);
    expect(stored).toHaveLength(1);
  });

  // Case-file behavior: the same suspicion resurfacing is one evolving case,
  // not a new entry every time.
  it("merges a near-identical re-sighting into the existing case", async () => {
    await noteSighting(path, hunch);
    const again = await noteSighting(path, { id: "p2", text: "spend velocity decay precedes churn across customers", domain: "posthog" });
    expect(again.sightings).toBe(2);
    expect((await loadHypotheses(path))).toHaveLength(1);
  });

  it("keeps unrelated hypotheses separate", async () => {
    await noteSighting(path, hunch);
    await noteSighting(path, { id: "p3", text: "voice minutes spike is one dialer customer", domain: "voice" });
    expect(await loadHypotheses(path)).toHaveLength(2);
  });

  // Jaccard alone under-merges restatements that add detail: the long tail of
  // extra tokens sinks the score below threshold. A production ledger split
  // ONE Google auth failure into 8 entries this way, and the volume then read
  // to thinking passes as 8 independent corroborations.
  it("merges a restatement that piles on extra detail", async () => {
    // Verbatim from the production ledger — these two scored 0.528 Jaccard
    // against a 0.6 threshold and opened as separate cases.
    await noteSighting(path, {
      id: "g1", domain: "general",
      text: "The agent is requesting an unusually broad set of Google API scopes, including full access to Drive, Calendar, Gmail, Chat, Contacts, and other services, potentially indicating an over-privileged application or a very broad, undefined purpose.",
    });
    const again = await noteSighting(path, {
      id: "g2", domain: "general",
      text: "The agent is requesting an unusually broad set of Google API scopes, including full read/write access to Drive, Calendar, Gmail, Sheets, Contacts, Presentations, Documents, Chat, and Google Apps Script, among others.",
    });
    expect(again.sightings).toBe(2);
    expect(await loadHypotheses(path)).toHaveLength(1);
  });

  // Containment without a length floor merges anything short into anything
  // long — a 6-token hunch shares 50% of its tokens with unrelated prose.
  it("does not merge a short hunch into an unrelated long one", async () => {
    await noteSighting(path, { id: "s1", text: "The agent explicitly confirms having an 'instinct'.", domain: "general" });
    await noteSighting(path, {
      id: "s2", domain: "general",
      text: "The agent explicitly states a tool `use-browser.sh` does not exist as a direct tool, despite instructions referring to it",
    });
    expect(await loadHypotheses(path)).toHaveLength(2);
  });
});

// An un-corroborated hunch is a guess, and a guess must not sit in pass
// context for two weeks presenting itself as a live case. Production held 20
// such entries — every one sightings:1 with last_seen == first_seen — and
// they drove a multi-day phantom-failure narrative.
describe("corroboration and stale-hunch expiry", () => {
  const hoursAgo = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
  const entry = (id: string, over: Partial<import("./hypotheses.js").Hypothesis>) => ({
    id, text: `hypothesis ${id} concerning subject ${id}`, domain: "d", status: "open" as const,
    sightings: 1, evidence: [], first_seen: hoursAgo(96), last_seen: hoursAgo(96), ...over,
  });

  const survivors = async () => {
    await noteSighting(path, hunch);
    return (await loadHypotheses(path)).map((h) => h.id);
  };
  const seed = async (...entries: unknown[]) => {
    await writeFile(path, JSON.stringify(entries));
  };

  it("expires an un-corroborated hunch after 72h, well before the 14-day bound", async () => {
    await seed(entry("stale-guess", {}), entry("recent-guess", { first_seen: hoursAgo(5), last_seen: hoursAgo(5) }));
    const kept = await survivors();
    expect(kept).not.toContain("stale-guess");
    expect(kept).toContain("recent-guess");
  });

  // Every inconclusive verdict in the production ledger said the investigator
  // could not reach the data at all. "I couldn't look" is not corroboration.
  it("does not treat an inconclusive verdict as corroboration", async () => {
    await seed(entry("only-inconclusive", {
      last_tested: hoursAgo(90),
      evidence: [{ at: hoursAgo(90), verdict: "inconclusive", note: "could not access configuration" }],
    }));
    expect(await survivors()).not.toContain("only-inconclusive");
  });

  it("keeps a hunch a real verdict corroborated", async () => {
    await seed(entry("supported-case", {
      status: "supported", last_tested: hoursAgo(90),
      evidence: [{ at: hoursAgo(90), verdict: "supported", note: "held across the cohort" }],
    }));
    expect(await survivors()).toContain("supported-case");
  });

  // Re-sighted LATER is corroboration. Several fragments merged inside one
  // burst is not — that inflates sightings without adding information.
  it("keeps a hunch re-sighted in a later pass", async () => {
    await seed(entry("resighted", { sightings: 3, first_seen: hoursAgo(96), last_seen: hoursAgo(80) }));
    expect(await survivors()).toContain("resighted");
  });

  it("expires a burst-merged hunch never seen again after the burst", async () => {
    await seed(entry("burst", { sightings: 4, first_seen: hoursAgo(96), last_seen: hoursAgo(96) }));
    expect(await survivors()).not.toContain("burst");
  });
});

describe("ledger pruning", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const entry = (id: string, over: Partial<import("./hypotheses.js").Hypothesis>) => ({
    id, text: `hypothesis ${id} about ${id}`, domain: "d", status: "open" as const,
    sightings: 1, evidence: [], first_seen: daysAgo(30), last_seen: daysAgo(1), ...over,
  });

  it("expires live hypotheses not sighted in 14 days on the next write", async () => {
    await writeFile(path, JSON.stringify([
      entry("stale", { last_seen: daysAgo(20) }),
      entry("fresh", { last_seen: daysAgo(2) }),
    ]));
    await noteSighting(path, hunch);
    const kept = (await loadHypotheses(path)).map((h) => h.id);
    expect(kept).not.toContain("stale");
    expect(kept).toContain("fresh");
  });

  it("drops refuted hypotheses after 7 days but keeps recent ones for dedup", async () => {
    await writeFile(path, JSON.stringify([
      entry("old-refuted", { status: "refuted", last_seen: daysAgo(10) }),
      entry("new-refuted", { status: "refuted", last_seen: daysAgo(2) }),
    ]));
    await noteSighting(path, hunch);
    const kept = (await loadHypotheses(path)).map((h) => h.id);
    expect(kept).not.toContain("old-refuted");
    expect(kept).toContain("new-refuted");
  });

  it("caps live hypotheses, keeping the most recently seen", async () => {
    // Corroborated (re-sighted well after first_seen) so the cap is what's
    // under test here, not the shorter un-corroborated expiry.
    const many = Array.from({ length: 40 }, (_, i) =>
      entry(`h${i}`, { sightings: 2, last_seen: daysAgo(13 - i * 0.2) }));
    await writeFile(path, JSON.stringify(many));
    await noteSighting(path, hunch);
    const live = (await loadHypotheses(path)).filter((h) => h.status !== "refuted");
    expect(live.length).toBeLessThanOrEqual(25);
    // The newest sightings survive the cap.
    expect(live.map((h) => h.id)).toContain("h39");
    expect(live.map((h) => h.id)).not.toContain("h0");
  });
});

describe("recordVerdict", () => {
  it("appends evidence and closes refuted hypotheses", async () => {
    const h = await noteSighting(path, hunch);
    await recordVerdict(path, h.id, "refuted", "no correlation in the full cohort");
    const [stored] = await loadHypotheses(path);
    expect(stored!.status).toBe("refuted");
    expect(stored!.evidence).toHaveLength(1);
    expect(stored!.evidence[0]!.note).toContain("no correlation");
  });

  it("marks supported hypotheses and keeps accumulating evidence", async () => {
    const h = await noteSighting(path, hunch);
    await recordVerdict(path, h.id, "supported", "8 of 9 churned accounts fit");
    await recordVerdict(path, h.id, "supported", "holds again this month");
    const [stored] = await loadHypotheses(path);
    expect(stored!.status).toBe("supported");
    expect(stored!.evidence).toHaveLength(2);
  });

  it("inconclusive verdicts leave the case open", async () => {
    const h = await noteSighting(path, hunch);
    await recordVerdict(path, h.id, "inconclusive", "not enough data yet");
    const [stored] = await loadHypotheses(path);
    expect(stored!.status).toBe("open");
    expect(stored!.last_tested).toBeDefined();
  });

  it("tolerates unknown hypothesis ids", async () => {
    await recordVerdict(path, "nope", "supported", "x");
    expect(await loadHypotheses(path)).toHaveLength(0);
  });
});

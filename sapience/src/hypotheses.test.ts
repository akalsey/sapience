import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
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
});

describe("ledger pruning", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const entry = (id: string, over: Partial<import("./hypotheses.js").Hypothesis>) => ({
    id, text: `hypothesis ${id} about ${id}`, domain: "d", status: "open" as const,
    sightings: 1, evidence: [], first_seen: daysAgo(30), last_seen: daysAgo(1), ...over,
  });

  it("expires live hypotheses not sighted in 14 days on the next write", async () => {
    const { writeFile } = await import("fs/promises");
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
    const { writeFile } = await import("fs/promises");
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
    const { writeFile } = await import("fs/promises");
    const many = Array.from({ length: 40 }, (_, i) => entry(`h${i}`, { last_seen: daysAgo(13 - i * 0.2) }));
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

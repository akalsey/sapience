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

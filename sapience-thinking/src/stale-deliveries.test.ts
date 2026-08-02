import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { dropStaleQueuedDeliveries } from "./stale-deliveries.js";
import type { OutcomeMap } from "./types.js";

let dir: string;
let queuePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stale-deliveries-"));
  queuePath = join(dir, "pending-deliveries.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rec = (
  id: string,
  passId: string,
  text: string,
  state: "pending" | "acted_on" = "pending"
) => ({
  proposal_id: id,
  proposal_type: "observation" as const,
  pass_id: passId,
  created_at: "2026-08-02T18:00:36.481Z",
  state,
  text,
});

const queued = (id: string, kind: "item" | "digest" = "item") => ({
  id,
  kind,
  prompt: `[SAPIENCE: CALIBRATE] ...${id}`,
  queued_at: "2026-08-02T18:00:55.691Z",
});

async function writeQueue(entries: unknown[]) {
  await writeFile(queuePath, JSON.stringify(entries), "utf-8");
}
async function readQueue(): Promise<Array<{ id: string }>> {
  return JSON.parse(await readFile(queuePath, "utf-8"));
}

describe("dropStaleQueuedDeliveries", () => {
  // The production failure this exists for: at 18:00 one pass produced both an
  // observation (aec91d1a) and the action derived from it (3adb4fbc). The user
  // answered the observation at 18:17; the action was still queued and shipped
  // at 18:30 as a fresh question about the subject just settled.
  it("drops queued items from the same pass as the answered proposal", async () => {
    const outcomes: OutcomeMap = {
      aec91d1a: rec("aec91d1a", "921374c0", "My reasoning flaw of conflating repeated memory entries ..."),
      "3adb4fbc": rec("3adb4fbc", "921374c0", "Synthesize the key lessons and update AGENTS.md ..."),
    };
    await writeQueue([queued("3adb4fbc")]);

    const dropped = await dropStaleQueuedDeliveries(queuePath, outcomes, "aec91d1a");

    expect(dropped).toEqual(["3adb4fbc"]);
    expect(await readQueue()).toEqual([]);
  });

  // The noticer burst emitted the same remark four times under four pass ids;
  // three were token-identical. Same-pass matching alone would miss them.
  it("drops near-identical queued items from other passes", async () => {
    const text = "The agent's internal memory system misfired by conflating past, isolated issues with a persistent problem, despite its own notes warning against it.";
    const outcomes: OutcomeMap = {
      a: rec("a", "notice-1", text),
      b: rec("b", "notice-2", text.replace("misfired", "'misfired'")),
    };
    await writeQueue([queued("b")]);

    expect(await dropStaleQueuedDeliveries(queuePath, outcomes, "a")).toEqual(["b"]);
  });

  it("keeps queued items that are unrelated to the answered one", async () => {
    const outcomes: OutcomeMap = {
      a: rec("a", "pass-1", "Google auth tokens look stale in the browser profile."),
      b: rec("b", "pass-2", "The Salesforce export dropped three columns this week."),
    };
    await writeQueue([queued("b")]);

    expect(await dropStaleQueuedDeliveries(queuePath, outcomes, "a")).toEqual([]);
    expect((await readQueue()).map((e) => e.id)).toEqual(["b"]);
  });

  // The weekly digest is not a proposal and has no outcome record; a pass-id
  // match must never take it out.
  it("never drops digest entries", async () => {
    const outcomes: OutcomeMap = { a: rec("a", "pass-1", "something") };
    await writeQueue([queued("digest-2026-08-02", "digest")]);

    expect(await dropStaleQueuedDeliveries(queuePath, outcomes, "a")).toEqual([]);
    expect((await readQueue()).map((e) => e.id)).toEqual(["digest-2026-08-02"]);
  });

  // A queued item with no outcome record can't be judged stale, so it stays —
  // dropping on absence would silently swallow anything the tracker evicted.
  it("keeps queued items with no matching outcome record", async () => {
    const outcomes: OutcomeMap = { a: rec("a", "pass-1", "something") };
    await writeQueue([queued("unknown-id")]);

    expect(await dropStaleQueuedDeliveries(queuePath, outcomes, "a")).toEqual([]);
  });

  it("is a no-op when the queue is missing or the id is unknown", async () => {
    const outcomes: OutcomeMap = { a: rec("a", "pass-1", "something") };
    expect(await dropStaleQueuedDeliveries(queuePath, outcomes, "a")).toEqual([]);

    await writeQueue([queued("b")]);
    expect(await dropStaleQueuedDeliveries(queuePath, outcomes, "nope")).toEqual([]);
    expect((await readQueue()).map((e) => e.id)).toEqual(["b"]);
  });

  // sapience's delivery cron empties this same file from another process with
  // no shared lock. Writing back a snapshot taken before the drain would put
  // already-delivered items back in the queue — the exact repeat this module
  // exists to stop — so removal must apply to whatever is on disk at write time.
  it("does not resurrect entries a concurrent drain removed", async () => {
    const outcomes: OutcomeMap = {
      a: rec("a", "pass-1", "answered"),
      b: rec("b", "pass-1", "sibling still queued"),
    };
    await writeQueue([queued("b")]);

    // Stand in for the delivery cron draining between the identify and write
    // steps: the queue is emptied after the first read.
    const realRead = (await import("./safe-json.js")).readJsonSafe;
    const spy = vi.spyOn(await import("./safe-json.js"), "readJsonSafe");
    let call = 0;
    spy.mockImplementation(async (...args: Parameters<typeof realRead>) => {
      call++;
      if (call === 2) await writeQueue([]);
      return realRead(...args);
    });

    try {
      const dropped = await dropStaleQueuedDeliveries(queuePath, outcomes, "a");
      expect(dropped).toEqual([]);
      expect(await readQueue()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  // Only rewrite the file when something actually goes, so an ordinary
  // record_outcome doesn't churn a file the delivery cron is draining.
  it("leaves the file untouched when nothing is stale", async () => {
    const outcomes: OutcomeMap = {
      a: rec("a", "pass-1", "Google auth tokens look stale."),
      b: rec("b", "pass-2", "The Salesforce export dropped columns."),
    };
    await writeQueue([queued("b")]);
    const before = await readFile(queuePath, "utf-8");

    await dropStaleQueuedDeliveries(queuePath, outcomes, "a");

    expect(await readFile(queuePath, "utf-8")).toBe(before);
  });
});

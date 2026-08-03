import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { addPendingDelivery, drainPendingDeliveries } from "./pending-deliveries.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pending-deliveries-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const path = () => join(dir, "pending-deliveries.json");

describe("addPendingDelivery", () => {
  it("queues an entry and reports it as new", async () => {
    const added = await addPendingDelivery(path(), {
      id: "prop-1", kind: "item", prompt: "[SAPIENCE: PROPOSE] do the thing",
    });
    expect(added).toBe(true);
    const drained = await drainPendingDeliveries(path());
    expect(drained).toHaveLength(1);
    expect(drained[0]!.prompt).toContain("do the thing");
    expect(drained[0]!.queued_at).toBeTruthy();
  });

  // The queue is drained one item per cron cycle, so twins don't arrive
  // together — they arrive as the same point made again 15 minutes later. The
  // user may not respond for days, so these must not be aged out; they must
  // never be queued. Production 2026-08-03 queued twelve items in one second
  // containing clusters of three near-identical observations apiece.
  it("rejects an entry that restates one already queued", async () => {
    const first = await addPendingDelivery(path(), {
      id: "a", kind: "item", prompt: "p1",
      text: "Lovable scrapers that previously provided customer insights were removed for fabricating data.",
    });
    const second = await addPendingDelivery(path(), {
      id: "b", kind: "item", prompt: "p2",
      text: "Previous customer insight scrapers ('Lovable scrapers') were removed for fabricating data.",
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await drainPendingDeliveries(path())).toHaveLength(1);
  });

  it("still queues a genuinely different finding", async () => {
    await addPendingDelivery(path(), {
      id: "a", kind: "item", prompt: "p1",
      text: "Lovable scrapers that previously provided customer insights were removed for fabricating data.",
    });
    const other = await addPendingDelivery(path(), {
      id: "b", kind: "item", prompt: "p2",
      text: "A scheduled audit found the Google Apps Script API is disabled for my cloud project.",
    });
    expect(other).toBe(true);
    expect(await drainPendingDeliveries(path())).toHaveLength(2);
  });

  // Entries queued before this field existed carry no text; they must still
  // queue and drain rather than being treated as matching everything.
  it("queues entries with no text alongside ones that have it", async () => {
    await addPendingDelivery(path(), { id: "a", kind: "item", prompt: "p1" });
    expect(await addPendingDelivery(path(), { id: "b", kind: "item", prompt: "p2" })).toBe(true);
    expect(await addPendingDelivery(path(), {
      id: "c", kind: "item", prompt: "p3", text: "Something entirely new about billing.",
    })).toBe(true);
    expect(await drainPendingDeliveries(path())).toHaveLength(3);
  });

  // A digest is not a finding and must never be suppressed by text overlap.
  it("never content-dedupes a digest", async () => {
    const shared = "The weekly digest covering proposals, outcomes and calibration for this week.";
    await addPendingDelivery(path(), { id: "item-1", kind: "item", prompt: "p", text: shared });
    expect(await addPendingDelivery(path(), {
      id: "digest-2026-08-03", kind: "digest", prompt: "d", text: shared,
    })).toBe(true);
  });

  it("dedupes by id so retry loops cannot queue the same delivery twice", async () => {
    await addPendingDelivery(path(), { id: "digest-2026-07-18", kind: "digest", prompt: "digest" });
    const again = await addPendingDelivery(path(), { id: "digest-2026-07-18", kind: "digest", prompt: "digest" });
    expect(again).toBe(false);
    expect(await drainPendingDeliveries(path())).toHaveLength(1);
  });

  it("bounds the queue, keeping the newest entries", async () => {
    for (let i = 0; i < 60; i++) {
      await addPendingDelivery(path(), { id: `p${i}`, kind: "item", prompt: `item ${i}` });
    }
    const drained = await drainPendingDeliveries(path());
    expect(drained.length).toBeLessThanOrEqual(50);
    expect(drained[drained.length - 1]!.id).toBe("p59");
  });
});

describe("drainPendingDeliveries", () => {
  it("returns entries once and leaves the queue empty", async () => {
    await addPendingDelivery(path(), { id: "a", kind: "item", prompt: "x" });
    expect(await drainPendingDeliveries(path())).toHaveLength(1);
    expect(await drainPendingDeliveries(path())).toHaveLength(0);
  });

  it("returns empty for a missing or corrupt file", async () => {
    expect(await drainPendingDeliveries(path())).toEqual([]);
    const { writeFile } = await import("fs/promises");
    await writeFile(path(), "{{{", "utf-8");
    expect(await drainPendingDeliveries(path())).toEqual([]);
  });
});

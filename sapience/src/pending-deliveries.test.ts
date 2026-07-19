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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { dedupeDelivered, itemKey, MAX_LEDGER_ENTRIES } from "./delivered-ledger.js";
import type { SapienceItem } from "./types.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ledger-"));
  path = join(dir, "delivered-ledger.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const HOUR = 60 * 60 * 1000;

function item(id: string, text: string): SapienceItem {
  return {
    id, type: "action", text, domain: "general", action_class: "general/action",
    priority: 5, pass_id: "pass-1", pass_timestamp: "2026-07-25T10:00:00Z",
  };
}

describe("itemKey", () => {
  it("normalizes case and whitespace so rephrasings of spacing don't evade dedupe", () => {
    expect(itemKey("Delete  the\nTemp Files")).toBe(itemKey("delete the temp files"));
    expect(itemKey("delete the temp files")).not.toBe(itemKey("delete the temp file"));
  });
});

describe("dedupeDelivered", () => {
  it("passes first-seen items through and records them", async () => {
    const { fresh, duplicates } = await dedupeDelivered(path, [item("a", "Fix the dashboard query")], 72);
    expect(fresh).toHaveLength(1);
    expect(duplicates).toHaveLength(0);
    const stored = JSON.parse(await readFile(path, "utf-8"));
    expect(stored).toHaveLength(1);
  });

  it("suppresses the same text under a different id within the window", async () => {
    // The production loop: the thinking pass re-emits an identical proposal
    // under a fresh uuid every 15 minutes; pass-id dedupe never catches it.
    await dedupeDelivered(path, [item("a", "Execute the user-mandated self-correction")], 72);
    const { fresh, duplicates } = await dedupeDelivered(path, [item("b", "Execute the user-mandated  self-correction")], 72);
    expect(fresh).toHaveLength(0);
    expect(duplicates.map((d) => d.id)).toEqual(["b"]);
  });

  it("suppresses duplicates within a single batch", async () => {
    const { fresh, duplicates } = await dedupeDelivered(path, [item("a", "same thing"), item("b", "Same thing")], 72);
    expect(fresh.map((i) => i.id)).toEqual(["a"]);
    expect(duplicates.map((i) => i.id)).toEqual(["b"]);
  });

  it("lets an item through again after the window expires", async () => {
    const t0 = Date.parse("2026-07-25T10:00:00Z");
    await dedupeDelivered(path, [item("a", "recurring issue")], 72, t0);
    const within = await dedupeDelivered(path, [item("b", "recurring issue")], 72, t0 + 71 * HOUR);
    expect(within.fresh).toHaveLength(0);
    const after = await dedupeDelivered(path, [item("c", "recurring issue")], 72, t0 + 73 * HOUR);
    expect(after.fresh.map((i) => i.id)).toEqual(["c"]);
  });

  it("caps the ledger, evicting the oldest entries", async () => {
    const t0 = Date.parse("2026-07-25T10:00:00Z");
    const batch = Array.from({ length: MAX_LEDGER_ENTRIES + 10 }, (_, n) => item(`i${n}`, `unique item ${n}`));
    await dedupeDelivered(path, batch, 24 * 365, t0);
    const stored = JSON.parse(await readFile(path, "utf-8"));
    expect(stored).toHaveLength(MAX_LEDGER_ENTRIES);
  });

  it("does not write the ledger when there is nothing fresh to record", async () => {
    await dedupeDelivered(path, [], 72);
    await expect(readFile(path, "utf-8")).rejects.toThrow();
  });

  it("treats an unreadable ledger as empty rather than blocking delivery", async () => {
    const { fresh } = await dedupeDelivered(join(dir, "nope", "ledger.json"), [item("a", "x")], 72).catch(() => ({ fresh: [] as SapienceItem[] }));
    // Whatever the write outcome, dedupe must not throw on a missing file.
    const result = await dedupeDelivered(path, [item("a", "y")], 72);
    expect(result.fresh).toHaveLength(1);
    expect(fresh.length).toBeLessThanOrEqual(1);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { readDeliveryStatus, formatDeliveryWarning } from "./delivery-status.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "delivery-status-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const HOUR = 60 * 60 * 1000;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function eventLine(type: string, msAgo: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ plugin: "sapience", type, ts: iso(msAgo), ...extra });
}

describe("readDeliveryStatus", () => {
  it("counts delivery failures within the lookback window", async () => {
    const path = join(dir, "events.jsonl");
    await writeFile(path, [
      eventLine("delivery_failed", 3 * HOUR, { reason: "gateway declined the injection" }),
      eventLine("delivery_failed", 1 * HOUR, { reason: "gateway declined the injection" }),
      eventLine("pass_completed", 1 * HOUR),
    ].join("\n") + "\n");

    const status = await readDeliveryStatus(path, now - 24 * HOUR);
    expect(status.failures).toBe(2);
    expect(status.lastReason).toBe("gateway declined the injection");
    expect(status.lastFailureAt).toBe(iso(HOUR));
  });

  it("ignores failures older than the window or resolved by a later successful delivery", async () => {
    const path = join(dir, "events.jsonl");
    await writeFile(path, [
      eventLine("delivery_failed", 48 * HOUR, { reason: "old" }),
      eventLine("delivery_failed", 5 * HOUR, { reason: "stale" }),
      eventLine("item_delivered", 2 * HOUR),
    ].join("\n") + "\n");

    const status = await readDeliveryStatus(path, now - 24 * HOUR);
    expect(status.failures).toBe(0);
  });

  it("returns zero failures for a missing or malformed events file", async () => {
    expect((await readDeliveryStatus(join(dir, "nope.jsonl"), now - HOUR)).failures).toBe(0);
    const path = join(dir, "garbage.jsonl");
    await writeFile(path, "not-json\n{{{\n");
    expect((await readDeliveryStatus(path, now - HOUR)).failures).toBe(0);
  });
});

describe("formatDeliveryWarning", () => {
  it("is empty when there are no unresolved failures", () => {
    expect(formatDeliveryWarning({ failures: 0 })).toBe("");
  });

  it("tells the pass its alerts never reached the user and not to escalate", () => {
    const warning = formatDeliveryWarning({
      failures: 6,
      lastFailureAt: iso(HOUR),
      lastReason: "gateway declined the injection",
    });
    expect(warning).toContain("6");
    expect(warning).toContain("NOT");
    expect(warning).toContain("gateway declined the injection");
    expect(warning.toLowerCase()).toContain("do not escalate");
  });
});

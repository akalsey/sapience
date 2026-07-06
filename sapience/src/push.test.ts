import { describe, it, expect } from "vitest";
import { shouldPush, notePush, requestChannelPush, localDateIn, DEFAULT_PUSH_POLICY } from "./push.js";

const policy = { ...DEFAULT_PUSH_POLICY, maxPerDay: 2, minPriority: 4 };
const fresh = { date: "", count: 0 };

describe("shouldPush", () => {
  it("pushes high-priority act/propose items within budget", () => {
    expect(shouldPush({ tier: "act", priority: 5 }, policy, fresh, "2026-07-05")).toBe(true);
    expect(shouldPush({ tier: "propose", priority: 4 }, policy, fresh, "2026-07-05")).toBe(true);
  });

  it("never pushes low-priority or ambient tiers", () => {
    expect(shouldPush({ tier: "propose", priority: 3 }, policy, fresh, "2026-07-05")).toBe(false);
    expect(shouldPush({ tier: "explore", priority: 5 }, policy, fresh, "2026-07-05")).toBe(false);
    expect(shouldPush({ tier: "learning", priority: 5 }, policy, fresh, "2026-07-05")).toBe(false);
  });

  it("respects the daily budget and resets it on a new day", () => {
    const spent = { date: "2026-07-05", count: 2 };
    expect(shouldPush({ tier: "act", priority: 5 }, policy, spent, "2026-07-05")).toBe(false);
    expect(shouldPush({ tier: "act", priority: 5 }, policy, spent, "2026-07-06")).toBe(true);
  });

  it("is disabled when the policy says so", () => {
    expect(shouldPush({ tier: "act", priority: 5 }, { ...policy, enabled: false }, fresh, "2026-07-05")).toBe(false);
  });
});

describe("notePush", () => {
  it("increments within a day and resets across days", () => {
    let s = notePush(fresh, "2026-07-05");
    expect(s).toEqual({ date: "2026-07-05", count: 1 });
    s = notePush(s, "2026-07-05");
    expect(s.count).toBe(2);
    s = notePush(s, "2026-07-06");
    expect(s).toEqual({ date: "2026-07-06", count: 1 });
  });
});

describe("localDateIn", () => {
  it("computes the date in the given timezone", () => {
    // 2026-07-06T02:00Z is still 2026-07-05 in Los Angeles.
    expect(localDateIn("America/Los_Angeles", new Date("2026-07-06T02:00:00Z"))).toBe("2026-07-05");
    expect(localDateIn("UTC", new Date("2026-07-06T02:00:00Z"))).toBe("2026-07-06");
  });
});

describe("requestChannelPush", () => {
  it("requests a heartbeat targeting the last active channel", () => {
    let received: any;
    const api = { runtime: { system: { requestHeartbeat: (opts: any) => { received = opts; } } } };
    expect(requestChannelPush(api, "sapience act: github")).toBe(true);
    expect(received.heartbeat).toEqual({ target: "last" });
    expect(received.reason).toContain("sapience");
    expect(received.intent).toBe("event");
  });

  it("degrades to false when the runtime surface is missing", () => {
    expect(requestChannelPush({}, "x")).toBe(false);
    expect(requestChannelPush({ runtime: { system: {} } }, "x")).toBe(false);
  });

  it("does not throw when the heartbeat request itself throws", () => {
    const api = { runtime: { system: { requestHeartbeat: () => { throw new Error("boom"); } } } };
    expect(requestChannelPush(api, "x")).toBe(false);
  });
});

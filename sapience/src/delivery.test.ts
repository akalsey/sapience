// src/delivery.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { buildTierPrompt, deliverItems } from "./delivery.js";
import type { RoutedItem } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "delivery-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); })

const base: RoutedItem = {
  id: "act-1", type: "action", text: "Fix the typo in dashboard query",
  domain: "posthog", action_class: "posthog/action",
  priority: 4, pass_id: "pass-1", pass_timestamp: "2026-05-20T10:00:00Z",
  tier: "act", confidence: 0.9,
};

// Mirrors the real gateway contract: enqueueNextTurnInjection resolves
// { enqueued, id, sessionKey } and requires a sessionKey in the injection.
const fakeApi = {
  config: {},
  session: {
    workflow: {
      enqueueNextTurnInjection: async (inj: { sessionKey: string }) => ({ enqueued: true, id: "1", sessionKey: inj.sessionKey }),
    },
  },
};

const decliningApi = {
  config: {},
  session: {
    workflow: {
      enqueueNextTurnInjection: async (inj: { sessionKey: string }) => ({ enqueued: false, id: "", sessionKey: inj.sessionKey }),
    },
  },
};

describe("buildTierPrompt", () => {
  it("Act prompt contains [SAPIENCE: ACT] and action text", () => {
    const p = buildTierPrompt({ ...base, tier: "act" });
    expect(p).toContain("[SAPIENCE: ACT]");
    expect(p).toContain("Fix the typo in dashboard query");
  });

  it("Propose prompt contains [SAPIENCE: PROPOSE]", () => {
    const p = buildTierPrompt({ ...base, tier: "propose" });
    expect(p).toContain("[SAPIENCE: PROPOSE]");
  });

  it("Ask prompt contains [SAPIENCE: ASK]", () => {
    const p = buildTierPrompt({ ...base, tier: "ask" });
    expect(p).toContain("[SAPIENCE: ASK]");
  });

  it("Explore prompt contains [SAPIENCE: EXPLORE]", () => {
    const p = buildTierPrompt({ ...base, tier: "explore" });
    expect(p).toContain("[SAPIENCE: EXPLORE]");
  });

  it("Learning prompt contains [SAPIENCE: CALIBRATE]", () => {
    const p = buildTierPrompt({ ...base, tier: "learning" });
    expect(p).toContain("[SAPIENCE: CALIBRATE]");
  });

  // The outcome loop: every delivered prompt instructs the agent to record the
  // user's reaction via record_outcome, carrying the proposal's identifiers.
  it("every tier prompt instructs the agent to record the outcome with the proposal's ids", () => {
    for (const tier of ["act", "propose", "ask", "explore", "learning"] as const) {
      const p = buildTierPrompt({ ...base, tier });
      expect(p, tier).toContain("record_outcome");
      expect(p, tier).toContain(base.id);
      expect(p, tier).toContain(base.action_class);
    }
  });

  it("every tier prompt subordinates itself to the user's own message", () => {
    // Injections prepend to the user's next turn. Without an explicit
    // priority rule, a delivered proposal can hijack the turn: the agent
    // answers the injection and drops the user's actual request.
    for (const tier of ["act", "propose", "ask", "explore", "learning"] as const) {
      const p = buildTierPrompt({ ...base, tier });
      expect(p, tier).toContain("user's message takes priority");
    }
  });

  it("the act prompt records acted_on after execution; propose offers the reaction set", () => {
    expect(buildTierPrompt({ ...base, tier: "act" })).toContain('"acted_on"');
    const propose = buildTierPrompt({ ...base, tier: "propose" });
    expect(propose).toContain('"rejected"');
    expect(propose).toContain('"acknowledged"');
  });
});

describe("deliverItems", () => {
  it("queues the item for the delivery cron when the injection is declined", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const pendingDeliveriesPath = join(dir, "pending-deliveries.json");
    const config = {
      ...DEFAULT_CONFIG,
      push: { ...DEFAULT_CONFIG.push, enabled: false },
      output: { ...DEFAULT_CONFIG.output, actionLogPath: join(dir, "action-log.md"), eventsPath, pendingDeliveriesPath },
    };
    const item = { ...base, tier: "propose" as const };
    await deliverItems([item], decliningApi, config);

    const { drainPendingDeliveries } = await import("./pending-deliveries.js");
    const queued = await drainPendingDeliveries(pendingDeliveriesPath);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBe(item.id);
    expect(queued[0]!.prompt).toContain(item.text);

    const events = (await readFile(eventsPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    const failed = events.find((e) => e.type === "delivery_failed");
    expect(failed.queued).toBe(true);
  });

  it("emits an action_logged event for act-tier items", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const config = {
      ...DEFAULT_CONFIG,
      push: { ...DEFAULT_CONFIG.push, enabled: false },
      output: {
        ...DEFAULT_CONFIG.output,
        actionLogPath: join(dir, "action-log.md"),
        eventsPath,
      },
    };
    const item = { ...base, tier: "act" as const, confidence: 0.9 };
    await deliverItems([item], fakeApi, config);
    const events = (await readFile(eventsPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    const ev = events.find((e) => e.type === "action_logged");
    expect(ev).toBeDefined();
    expect(ev.plugin).toBe("sapience");
    expect(ev.domain).toBe(item.domain);
    expect(ev.confidence).toBe(0.9);
  });

  it("emits an item_delivered receipt for every successful injection", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const config = {
      ...DEFAULT_CONFIG,
      push: { ...DEFAULT_CONFIG.push, enabled: false },
      output: { ...DEFAULT_CONFIG.output, actionLogPath: join(dir, "action-log.md"), eventsPath },
    };
    await deliverItems([{ ...base, tier: "learning" as const, priority: 5 }], fakeApi, config);
    const events = (await readFile(eventsPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    const receipt = events.find((e) => e.type === "item_delivered");
    expect(receipt).toBeDefined();
    expect(receipt.tier).toBe("learning");
    expect(receipt.priority).toBe(5);
  });

  it("emits no delivery events for non-act tiers other than the receipt", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const config = {
      ...DEFAULT_CONFIG,
      push: { ...DEFAULT_CONFIG.push, enabled: false },
      output: {
        ...DEFAULT_CONFIG.output,
        actionLogPath: join(dir, "action-log.md"),
        eventsPath,
      },
    };
    const item = { ...base, tier: "propose" as const, confidence: 0.5, priority: 2 };
    await deliverItems([item], fakeApi, config);
    const events = (await readFile(eventsPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.every((e) => e.type === "item_delivered")).toBe(true);
  });

  it("requests a channel push for high-priority act items, within the daily budget", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const heartbeats: any[] = [];
    const pushApi = {
      ...fakeApi,
      runtime: { system: { requestHeartbeat: (o: any) => { heartbeats.push(o); } } },
    };
    const config = {
      ...DEFAULT_CONFIG,
      push: { enabled: true, maxPerDay: 1, minPriority: 4 },
      output: {
        ...DEFAULT_CONFIG.output,
        actionLogPath: join(dir, "action-log.md"),
        eventsPath,
        pushStatePath: join(dir, "push-state.json"),
      },
    };
    const high1 = { ...base, id: "a1", tier: "act" as const, priority: 5 };
    const high2 = { ...base, id: "a2", tier: "act" as const, priority: 5 };
    const low = { ...base, id: "a3", tier: "propose" as const, priority: 2 };
    await deliverItems([high1, low, high2], pushApi, config);

    // Budget of 1: only the first high-priority item pushes.
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0].heartbeat).toEqual({ target: "last" });
    const events = (await readFile(eventsPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.filter((e) => e.type === "push_requested")).toHaveLength(1);
  });

  it("does not push when the injection itself failed", async () => {
    const heartbeats: any[] = [];
    const pushApi = {
      ...decliningApi,
      runtime: { system: { requestHeartbeat: (o: any) => { heartbeats.push(o); } } },
    };
    const config = {
      ...DEFAULT_CONFIG,
      push: { enabled: true, maxPerDay: 5, minPriority: 4 },
      output: {
        ...DEFAULT_CONFIG.output,
        actionLogPath: join(dir, "action-log.md"),
        eventsPath: join(dir, "events.jsonl"),
        pushStatePath: join(dir, "push-state.json"),
      },
    };
    await deliverItems([{ ...base, tier: "act" as const, priority: 5 }], pushApi, config);
    expect(heartbeats).toHaveLength(0);
  });

  it("emits a delivery_failed event when the gateway declines the injection", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const config = {
      ...DEFAULT_CONFIG,
      output: {
        ...DEFAULT_CONFIG.output,
        actionLogPath: join(dir, "action-log.md"),
        eventsPath,
      },
    };
    const item = { ...base, tier: "propose" as const, confidence: 0.5 };
    await deliverItems([item], decliningApi, config);
    const ev = JSON.parse((await readFile(eventsPath, "utf-8")).trim());
    expect(ev.type).toBe("delivery_failed");
    expect(ev.reason).toBeDefined();
  });
});

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

// DEFAULT_CONFIG.output paths are workspace-relative, so any test that spreads
// it without overriding EVERY path writes into the repo working tree — that is
// how `sapience/sapience/pending-deliveries.json` got committed. Redirect the
// whole map into the temp dir; overrides are for paths a test needs to read.
function sandboxOutput(over: Partial<typeof DEFAULT_CONFIG.output> = {}) {
  const redirected = Object.fromEntries(
    Object.entries(DEFAULT_CONFIG.output).map(([key, rel]) => [key, join(dir, rel)])
  ) as typeof DEFAULT_CONFIG.output;
  return { ...redirected, ...over };
}

const base: RoutedItem = {
  id: "act-1", type: "action", text: "Fix the typo in dashboard query",
  domain: "posthog", action_class: "posthog/action",
  priority: 4, pass_id: "pass-1", pass_timestamp: "2026-05-20T10:00:00Z",
  tier: "act", confidence: 0.9,
};

// Distinct subjects, because the pending queue now rejects a restatement of
// something already waiting. Spreading `base` gives every item the SAME text,
// which the queue is right to collapse — these tests are about overflow
// ordering and injection fallback, so they need items that really are
// different findings.
const SUBJECTS = [
  "Fix the typo in the dashboard query",
  "Archive the stale Salesforce contacts nobody has touched this quarter",
  "Rotate the PostHog API key that expires next month",
  "Publish the weekly activation funnel export to the shared drive",
  "Investigate the duplicate Apple accounts in the CRM",
];
const subject = (n: number) => SUBJECTS[(n - 1) % SUBJECTS.length]!;

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

// Captures every injection so tests can assert how many separate notes a
// routing run puts in front of the user, not just how many items it routed.
function recordingApi() {
  const injections: string[] = [];
  return {
    injections,
    api: {
      config: {},
      session: {
        workflow: {
          enqueueNextTurnInjection: async (inj: { sessionKey: string; text: string }) => {
            injections.push(inj.text);
            return { enqueued: true, id: "1", sessionKey: inj.sessionKey };
          },
        },
      },
    },
  };
}

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

  // The delivered note reads to the receiving agent like an independent
  // monitoring signal, so it outranked the agent's own first-hand evidence.
  // In production the agent ran the Google auth flow, confirmed it worked with
  // a successful list_drive_items call, told the user so — and twelve minutes
  // later a delivery arrived and it wrote "the cron job's message just now is
  // definitive proof that the Google Authentication issue is not resolved",
  // then apologized for having said it was fine. The pass that produced that
  // note had seen none of the conversation.
  it("every tier prompt discloses that the pass did not see the conversation", () => {
    for (const tier of ["act", "propose", "ask", "explore", "learning"] as const) {
      const p = buildTierPrompt({ ...base, tier });
      expect(p, tier).toMatch(/did not see|has not seen|no visibility into/i);
    }
  });

  it("every tier prompt ranks the agent's own first-hand evidence above the note", () => {
    for (const tier of ["act", "propose", "ask", "explore", "learning"] as const) {
      const p = buildTierPrompt({ ...base, tier });
      expect(p, tier).toMatch(/first-hand|what you have (directly )?observed|your own evidence/i);
      // and it must not read as confirmation of anything
      expect(p, tier).toMatch(/not confirmation|not evidence|does not confirm/i);
    }
  });

  it("the act prompt records acted_on after execution; propose offers the reaction set", () => {
    expect(buildTierPrompt({ ...base, tier: "act" })).toContain('"acted_on"');
    const propose = buildTierPrompt({ ...base, tier: "propose" });
    expect(propose).toContain('"rejected"');
    expect(propose).toContain('"acknowledged"');
  });

  it("describes content, never scripts wording — the user reads these daily", () => {
    // Production feedback: every calibrate note opened with the same
    // fill-in-the-blanks sentence because the prompt dictated it verbatim.
    for (const tier of ["act", "propose", "ask", "explore", "learning"] as const) {
      const p = buildTierPrompt({ ...base, tier });
      expect(p, tier).toContain("own words");
    }
    const learning = buildTierPrompt({ ...base, tier: "learning" });
    expect(learning).not.toContain("Is that the right level of initiative");
    expect(learning).not.toContain('Tell the user: "');
    expect(buildTierPrompt({ ...base, tier: "act" })).not.toContain('"I just [');
  });
});

describe("deliverItems", () => {
  it("delivers at most maxPerCycle items per routing run and queues the overflow by priority", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const pendingDeliveriesPath = join(dir, "pending-deliveries.json");
    const config = {
      ...DEFAULT_CONFIG,
      push: { ...DEFAULT_CONFIG.push, enabled: false },
      delivery: { ...DEFAULT_CONFIG.delivery, maxPerCycle: 2 },
      output: sandboxOutput({ actionLogPath: join(dir, "action-log.md"), eventsPath, pendingDeliveriesPath }),
    };
    const items = [1, 2, 3, 4, 5].map((n) => ({
      ...base, id: `p${n}`, text: subject(n), tier: "learning" as const, priority: (n <= 2 ? 5 : 2) as 5 | 2,
    }));
    await deliverItems(items, fakeApi, config);
    const events = (await readFile(eventsPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    const delivered = events.filter((e) => e.type === "item_delivered").map((e) => e.proposal_id);
    expect(delivered).toEqual(["p1", "p2"]);
    const { drainPendingDeliveries } = await import("./pending-deliveries.js");
    const queued = await drainPendingDeliveries(pendingDeliveriesPath);
    expect(queued.map((q) => q.id).sort()).toEqual(["p3", "p4", "p5"]);
    expect(events.filter((e) => e.type === "item_queued")).toHaveLength(3);
  });

  it("queues the item for the delivery cron when the injection is declined", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const pendingDeliveriesPath = join(dir, "pending-deliveries.json");
    const config = {
      ...DEFAULT_CONFIG,
      push: { ...DEFAULT_CONFIG.push, enabled: false },
      output: sandboxOutput({ actionLogPath: join(dir, "action-log.md"), eventsPath, pendingDeliveriesPath }),
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
      output: sandboxOutput({
        actionLogPath: join(dir, "action-log.md"),
        eventsPath,
      }),
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
      output: sandboxOutput({ actionLogPath: join(dir, "action-log.md"), eventsPath }),
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
      output: sandboxOutput({
        actionLogPath: join(dir, "action-log.md"),
        eventsPath,
      }),
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
      output: sandboxOutput({
        actionLogPath: join(dir, "action-log.md"),
        eventsPath,
        pushStatePath: join(dir, "push-state.json"),
      }),
    };
    const high1 = { ...base, id: "a1", text: subject(1), tier: "act" as const, priority: 5 };
    const high2 = { ...base, id: "a2", text: subject(2), tier: "act" as const, priority: 5 };
    const low = { ...base, id: "a3", text: subject(3), tier: "propose" as const, priority: 2 };
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
      output: sandboxOutput({
        actionLogPath: join(dir, "action-log.md"),
        eventsPath: join(dir, "events.jsonl"),
        pushStatePath: join(dir, "push-state.json"),
      }),
    };
    await deliverItems([{ ...base, tier: "act" as const, priority: 5 }], pushApi, config);
    expect(heartbeats).toHaveLength(0);
  });

  // Production: one turn arrived carrying 15 separate CALIBRATE notes, each
  // with its own copy of the priority guard, ahead of a 23-character user
  // message. Whatever survives the cap ships as ONE note with ONE guard.
  it("coalesces the selected items into a single injection with one priority guard", async () => {
    const { api, injections } = recordingApi();
    const eventsPath = join(dir, "events.jsonl");
    const config = {
      ...DEFAULT_CONFIG,
      push: { ...DEFAULT_CONFIG.push, enabled: false },
      delivery: { ...DEFAULT_CONFIG.delivery, maxPerCycle: 3 },
      output: sandboxOutput({ actionLogPath: join(dir, "action-log.md"), eventsPath, pendingDeliveriesPath: join(dir, "pending.json") }),
    };
    const items = [1, 2, 3].map((n) => ({ ...base, id: `p${n}`, text: subject(n), tier: "learning" as const }));
    await deliverItems(items, api, config);

    expect(injections).toHaveLength(1);
    const note = injections[0]!;
    expect(note.match(/user's message takes priority/g)).toHaveLength(1);
    expect(note.match(/own words/g)).toHaveLength(1);
    for (const item of items) expect(note).toContain(item.text);
    // Each item still gets its own receipt and its own record_outcome handle.
    const events = (await readFile(eventsPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.filter((e) => e.type === "item_delivered").map((e) => e.proposal_id)).toEqual(["p1", "p2", "p3"]);
    for (const item of items) expect(note).toContain(`proposal_id: "${item.id}"`);
  });

  it("defaults to one item per routing run", async () => {
    const { api, injections } = recordingApi();
    const pendingDeliveriesPath = join(dir, "pending-deliveries.json");
    const config = {
      ...DEFAULT_CONFIG,
      push: { ...DEFAULT_CONFIG.push, enabled: false },
      output: sandboxOutput({ actionLogPath: join(dir, "action-log.md"), eventsPath: join(dir, "events.jsonl"), pendingDeliveriesPath }),
    };
    const items = [1, 2, 3, 4].map((n) => ({ ...base, id: `p${n}`, text: subject(n), tier: "learning" as const }));
    await deliverItems(items, api, config);

    expect(DEFAULT_CONFIG.delivery.maxPerCycle).toBe(1);
    expect(injections).toHaveLength(1);
    expect(injections[0]!.match(/\[SAPIENCE: CALIBRATE\]/g)).toHaveLength(1);
    const { drainPendingDeliveries } = await import("./pending-deliveries.js");
    expect((await drainPendingDeliveries(pendingDeliveriesPath)).map((q) => q.id)).toEqual(["p2", "p3", "p4"]);
  });

  it("queues every selected item when the single injection is declined", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const pendingDeliveriesPath = join(dir, "pending-deliveries.json");
    const config = {
      ...DEFAULT_CONFIG,
      push: { ...DEFAULT_CONFIG.push, enabled: false },
      delivery: { ...DEFAULT_CONFIG.delivery, maxPerCycle: 2 },
      output: sandboxOutput({ actionLogPath: join(dir, "action-log.md"), eventsPath, pendingDeliveriesPath }),
    };
    const items = [1, 2].map((n) => ({ ...base, id: `p${n}`, text: subject(n), tier: "propose" as const }));
    await deliverItems(items, decliningApi, config);

    const { drainPendingDeliveries } = await import("./pending-deliveries.js");
    expect((await drainPendingDeliveries(pendingDeliveriesPath)).map((q) => q.id).sort()).toEqual(["p1", "p2"]);
    const events = (await readFile(eventsPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.filter((e) => e.type === "delivery_failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "item_delivered")).toHaveLength(0);
  });

  it("emits a delivery_failed event when the gateway declines the injection", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const config = {
      ...DEFAULT_CONFIG,
      output: sandboxOutput({
        actionLogPath: join(dir, "action-log.md"),
        eventsPath,
      }),
    };
    const item = { ...base, tier: "propose" as const, confidence: 0.5 };
    await deliverItems([item], decliningApi, config);
    const ev = JSON.parse((await readFile(eventsPath, "utf-8")).trim());
    expect(ev.type).toBe("delivery_failed");
    expect(ev.reason).toBeDefined();
  });
});

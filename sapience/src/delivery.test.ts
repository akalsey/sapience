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

  it("the act prompt records acted_on after execution; propose offers the reaction set", () => {
    expect(buildTierPrompt({ ...base, tier: "act" })).toContain('"acted_on"');
    const propose = buildTierPrompt({ ...base, tier: "propose" });
    expect(propose).toContain('"rejected"');
    expect(propose).toContain('"acknowledged"');
  });
});

describe("deliverItems", () => {
  it("emits an action_logged event for act-tier items", async () => {
    const eventsPath = join(dir, "events.jsonl");
    const config = {
      ...DEFAULT_CONFIG,
      output: {
        ...DEFAULT_CONFIG.output,
        actionLogPath: join(dir, "action-log.md"),
        eventsPath,
      },
    };
    const item = { ...base, tier: "act" as const, confidence: 0.9 };
    await deliverItems([item], fakeApi, config);
    const ev = JSON.parse((await readFile(eventsPath, "utf-8")).trim());
    expect(ev.type).toBe("action_logged");
    expect(ev.plugin).toBe("sapience");
    expect(ev.domain).toBe(item.domain);
    expect(ev.confidence).toBe(0.9);
  });

  it("emits no event for non-act tiers", async () => {
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
    await deliverItems([item], fakeApi, config);
    await expect(readFile(eventsPath, "utf-8")).rejects.toThrow();
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

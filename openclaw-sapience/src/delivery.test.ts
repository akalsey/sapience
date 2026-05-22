// src/delivery.test.ts
import { describe, it, expect } from "vitest";
import { buildTierPrompt } from "./delivery.js";
import type { RoutedItem } from "./types.js";

const base: RoutedItem = {
  id: "act-1", type: "action", text: "Fix the typo in dashboard query",
  domain: "posthog", action_class: "posthog/action",
  priority: 4, pass_id: "pass-1", pass_timestamp: "2026-05-20T10:00:00Z",
  tier: "act", confidence: 0.9,
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
});

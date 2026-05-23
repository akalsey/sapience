import { describe, it, expect } from "vitest";
import { routeItem } from "./autonomy.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { SapienceItem, CalibrationEntry } from "./types.js";

const item: SapienceItem = {
  id: "obs-001", type: "observation", text: "something in posthog",
  domain: "posthog", action_class: "observation",
  priority: 3, pass_id: "pass-1", pass_timestamp: "2026-05-20T10:00:00Z",
};

const calibratedEntry: CalibrationEntry = {
  domain: "posthog", action_class: "observation",
  tier: "act", confidence: 0.8,
  confirmed_count: 5, corrected_count: 0,
  last_calibrated: "2026-05-20T00:00:00Z", notes: "",
};

describe("routeItem", () => {
  it("returns learning tier when profile is empty and learning enabled", () => {
    const routed = routeItem(item, [], { ...DEFAULT_CONFIG, learning: { ...DEFAULT_CONFIG.learning, enabled: true } });
    expect(routed.tier).toBe("learning");
  });

  it("returns calibrated tier when entry exists with sufficient confidence", () => {
    const routed = routeItem(item, [calibratedEntry], DEFAULT_CONFIG);
    expect(routed.tier).toBe("act");
    expect(routed.confidence).toBe(0.8);
  });

  it("returns learning tier when confidence below threshold", () => {
    const lowConf = { ...calibratedEntry, confidence: 0.3 };
    const routed = routeItem(item, [lowConf], DEFAULT_CONFIG);
    expect(routed.tier).toBe("learning");
  });

  it("applies domain floor — cannot route above floor", () => {
    const config = { ...DEFAULT_CONFIG, autonomy: { ...DEFAULT_CONFIG.autonomy, domainFloors: { posthog: "propose" as const } } };
    const routed = routeItem(item, [calibratedEntry], config);
    expect(routed.tier).toBe("propose"); // floor prevents Act
  });

  it("falls back to defaultTier for unknown domain/class", () => {
    const routed = routeItem(item, [], { ...DEFAULT_CONFIG, learning: { ...DEFAULT_CONFIG.learning, enabled: false } });
    expect(routed.tier).toBe(DEFAULT_CONFIG.autonomy.defaultTier);
  });
});

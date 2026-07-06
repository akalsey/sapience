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

describe("evidence gating", () => {
  // An unverified hunch must never route to act/propose no matter how much
  // confidence the domain has earned — weak evidence caps initiative.
  it("caps hunch-graded items at explore even in a high-confidence domain", () => {
    const profile = [
      { domain: "posthog", action_class: "posthog/action", tier: "act" as const, confidence: 0.95, confirmed_count: 10, corrected_count: 0, last_calibrated: "2026-01-01T00:00:00Z", notes: "" },
    ];
    const item = {
      id: "i1", type: "action" as const, text: "spend velocity predicts churn — act on it",
      domain: "posthog", action_class: "posthog/action", priority: 4,
      pass_id: "p", pass_timestamp: "t", evidence_grade: "hunch" as const,
    };
    const routed = routeItem(item, profile, DEFAULT_CONFIG);
    expect(routed.tier).toBe("explore");
  });

  it("leaves quick_check and ungraded items on their earned tier", () => {
    const profile = [
      { domain: "posthog", action_class: "posthog/action", tier: "act" as const, confidence: 0.95, confirmed_count: 10, corrected_count: 0, last_calibrated: "2026-01-01T00:00:00Z", notes: "" },
    ];
    const base = {
      id: "i1", type: "action" as const, text: "x", domain: "posthog", action_class: "posthog/action",
      priority: 4, pass_id: "p", pass_timestamp: "t", reversible: true,
    };
    expect(routeItem({ ...base, evidence_grade: "quick_check" as const }, profile, DEFAULT_CONFIG).tier).toBe("act");
    expect(routeItem(base, profile, DEFAULT_CONFIG).tier).toBe("act");
  });
});

describe("reversibility gating", () => {
  const profile = [
    { domain: "posthog", action_class: "posthog/action", tier: "act" as const, confidence: 0.95, confirmed_count: 10, corrected_count: 0, last_calibrated: new Date().toISOString(), notes: "" },
  ];
  const base = {
    id: "i1", type: "action" as const, text: "x", domain: "posthog", action_class: "posthog/action",
    priority: 4, pass_id: "p", pass_timestamp: "t",
  };

  // Autonomous execution requires EXPLICITLY reversible actions — unknown
  // blast radius caps at propose no matter the earned confidence.
  it("caps act at propose unless the action is explicitly reversible", () => {
    expect(routeItem({ ...base }, profile, DEFAULT_CONFIG).tier).toBe("propose");
    expect(routeItem({ ...base, reversible: false }, profile, DEFAULT_CONFIG).tier).toBe("propose");
    expect(routeItem({ ...base, reversible: true }, profile, DEFAULT_CONFIG).tier).toBe("act");
  });
});

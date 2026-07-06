// src/feedback-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseMessage } from "./feedback-parser.js";

describe("parseMessage", () => {
  it("detects explicit correction with don't", () => {
    const signals = parseMessage("don't update OKRs for other teams without asking");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("correction");
    expect(signals[0]!.raw_text).toContain("don't update OKRs");
  });

  it("detects tier adjustment 'just do it'", () => {
    const signals = parseMessage("next time just do it, you don't need to ask");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("tier_adjustment");
    expect(signals[0]!.suggested_tier).toBe("act");
  });

  it("detects 'ask me first' tier adjustment", () => {
    const signals = parseMessage("always ask me first before touching Salesforce");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("tier_adjustment");
    expect(signals[0]!.suggested_tier).toBe("ask");
  });

  it("detects positive confirmation", () => {
    const signals = parseMessage("yes exactly, good call on that one");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("confirmation");
  });

  it("detects 'good call' confirmation", () => {
    const signals = parseMessage("good call fixing that query");
    expect(signals[0]!.type).toBe("confirmation");
  });

  it("returns empty array for neutral message", () => {
    const signals = parseMessage("what time is the meeting tomorrow?");
    expect(signals).toHaveLength(0);
  });

  it("extracts domain from context when present", () => {
    const signals = parseMessage("don't push to GitHub main without asking");
    expect(signals[0]!.domain).toBe("github");
  });
});

describe("method feedback", () => {
  // "Whenever you look at churn, segment by plan tier" isn't a correction or a
  // confirmation — it's teaching the agent HOW to analyze. It becomes a
  // playbook, not a confidence change.
  it("detects 'whenever you X' methodology teaching", () => {
    const signals = parseMessage("whenever you look at churn, segment by plan tier");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("method");
  });

  it("detects 'always check/segment/decompose' teaching", () => {
    const signals = parseMessage("always check for outliers before reporting an average");
    expect(signals[0]!.type).toBe("method");
  });

  it("does not flag ordinary corrections as method feedback", () => {
    const signals = parseMessage("don't push to github without asking");
    expect(signals.every((s) => s.type !== "method")).toBe(true);
  });
});

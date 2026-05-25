import { describe, it, expect, vi } from "vitest";
import { classifyWithLlm, buildClassifierMessages } from "./llm-classifier.js";
import type { LlmClient, LlmCompleteParams } from "./types.js";

function makeClient(jsonOrResponse: string | ((p: LlmCompleteParams) => string)): LlmClient {
  return {
    complete: vi.fn(async (params: LlmCompleteParams) => ({
      text: typeof jsonOrResponse === "function" ? jsonOrResponse(params) : jsonOrResponse,
    })),
  };
}

describe("classifyWithLlm", () => {
  it("detects a correction phrased as a leading question", async () => {
    const client = makeClient(JSON.stringify({
      signals: [{ type: "correction", domain: "credentials", action_class: "general", suggested_tier: null, confidence: 0.9 }],
    }));
    const signals = await classifyWithLlm("did you look in the password manager before asking", client);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("correction");
    expect(signals[0]!.domain).toBe("credentials");
    expect(signals[0]!.source).toBe("llm");
    expect(signals[0]!.confidence).toBe(0.9);
  });

  it("detects a tier adjustment regardless of trigger words", async () => {
    const client = makeClient(JSON.stringify({
      signals: [{ type: "tier_adjustment", domain: "credentials", action_class: "general", suggested_tier: "ask", confidence: 0.95 }],
    }));
    const signals = await classifyWithLlm(
      "you need to always look at your password manager before asking me for credentials",
      client
    );
    expect(signals[0]!.type).toBe("tier_adjustment");
    expect(signals[0]!.suggested_tier).toBe("ask");
  });

  it("filters out low-confidence signals", async () => {
    const client = makeClient(JSON.stringify({
      signals: [{ type: "correction", domain: "general", action_class: "general", suggested_tier: null, confidence: 0.4 }],
    }));
    const signals = await classifyWithLlm("hmm", client, { minConfidence: 0.6 });
    expect(signals).toHaveLength(0);
  });

  it("returns empty array when LLM reports no signals", async () => {
    const client = makeClient(JSON.stringify({ signals: [] }));
    const signals = await classifyWithLlm("what time is the standup", client);
    expect(signals).toHaveLength(0);
  });

  it("tolerates JSON wrapped in ```json fences", async () => {
    const client = makeClient(
      "```json\n" +
      JSON.stringify({ signals: [{ type: "confirmation", domain: "general", action_class: "general", suggested_tier: null, confidence: 0.8 }] }) +
      "\n```"
    );
    const signals = await classifyWithLlm("yes that's exactly what I wanted", client);
    expect(signals[0]!.type).toBe("confirmation");
  });

  it("returns empty array when LLM output is unparseable", async () => {
    const client = makeClient("not json at all");
    const signals = await classifyWithLlm("something", client);
    expect(signals).toHaveLength(0);
  });

  it("preserves the original text as message and raw_text", async () => {
    const client = makeClient(JSON.stringify({
      signals: [{ type: "correction", domain: "general", action_class: "general", suggested_tier: null, confidence: 0.8 }],
    }));
    const text = "stop overwriting my changes";
    const signals = await classifyWithLlm(text, client);
    expect(signals[0]!.message).toBe(text);
    expect(signals[0]!.raw_text).toBe(text);
  });

  it("passes a purpose string to the LLM call", async () => {
    const client = makeClient(JSON.stringify({ signals: [] }));
    await classifyWithLlm("anything", client);
    const call = (client.complete as unknown as { mock: { calls: LlmCompleteParams[][] } }).mock.calls[0]![0];
    expect(call.purpose).toMatch(/sapience-feedback/);
  });

  it("does not specify a model (uses default provider)", async () => {
    const client = makeClient(JSON.stringify({ signals: [] }));
    await classifyWithLlm("anything", client);
    const call = (client.complete as unknown as { mock: { calls: LlmCompleteParams[][] } }).mock.calls[0]![0];
    expect((call as unknown as { model?: string }).model).toBeUndefined();
  });

  it("drops invalid signal entries instead of throwing", async () => {
    const client = makeClient(JSON.stringify({
      signals: [
        { type: "bogus", domain: "x", action_class: "y", confidence: 0.9 },
        { type: "correction", domain: "general", action_class: "general", suggested_tier: null, confidence: 0.8 },
      ],
    }));
    const signals = await classifyWithLlm("hi", client);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("correction");
  });
});

describe("buildClassifierMessages", () => {
  it("places the user message verbatim in the user role", () => {
    const msgs = buildClassifierMessages("did you check the password manager");
    const userMsg = msgs.find(m => m.role === "user");
    expect(userMsg?.content).toContain("did you check the password manager");
  });

  it("includes a system prompt covering the three signal types", () => {
    const msgs = buildClassifierMessages("anything");
    const system = msgs.find(m => m.role === "system");
    expect(system?.content).toMatch(/correction/i);
    expect(system?.content).toMatch(/confirmation/i);
    expect(system?.content).toMatch(/tier_adjustment/i);
  });
});

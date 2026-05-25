import type { DetectedSignal, FeedbackSignalType, LlmClient, LlmCompleteMessage } from "./types.js";

const VALID_TYPES: ReadonlySet<FeedbackSignalType> = new Set(["correction", "confirmation", "tier_adjustment"]);
const VALID_TIERS = new Set(["act", "propose", "ask", "explore"]);

const SYSTEM_PROMPT = `You analyze ONE chat message a developer sent to their AI coding agent. Decide whether it contains behavioral feedback the agent should learn from.

Three signal types:

1. "correction" — the user is correcting the agent, pointing out a mistake, redirecting an approach, expressing frustration with a recent action, or telling it to use a different tool/source. This includes leading questions like "did you check X first?" or "is there something wrong with X?" — these are corrections phrased as rhetorical questions.

2. "confirmation" — the user is reinforcing what the agent just did: praising, agreeing, asking it to keep behaving that way.

3. "tier_adjustment" — the user is changing the agent's autonomy level:
   - suggested_tier "act": user wants less asking ("just do it", "stop asking", "go ahead without me")
   - suggested_tier "ask": user wants more checking ("always ask first", "never do that without checking", "check X before doing Y")

A message is NOT feedback if it is: a fresh task request, a technical question about code or systems, a code snippet, conversational filler, or status unrelated to the agent's behavior.

When unsure, prefer empty output — false positives are worse than misses.

For each detected signal extract:
- "type": one of "correction" | "confirmation" | "tier_adjustment"
- "domain": short kebab-case slug for the subject area. Use what fits: "github", "credentials", "okr-system", "salesforce", "slack", "slides", "linear", "posthog", or invent a clear one. Use "general" only if nothing specific applies.
- "action_class": short slug; "general" if nothing more specific
- "suggested_tier": "act" | "propose" | "ask" | "explore" — only set for tier_adjustment, otherwise null
- "confidence": 0..1, how confident you are this is genuine feedback

Respond with ONLY a single JSON object, no prose, no code fences:

{"signals":[{"type":"...","domain":"...","action_class":"general","suggested_tier":null,"confidence":0.0}]}

If no feedback: {"signals":[]}

Examples:

Message: "did you look in the password manager before asking me for credentials"
Response: {"signals":[{"type":"correction","domain":"credentials","action_class":"general","suggested_tier":null,"confidence":0.9}]}

Message: "you need to always look at your password manager before asking me for credentials"
Response: {"signals":[{"type":"tier_adjustment","domain":"credentials","action_class":"general","suggested_tier":"ask","confidence":0.92}]}

Message: "is there something wrong with the passwords you have"
Response: {"signals":[{"type":"correction","domain":"credentials","action_class":"general","suggested_tier":null,"confidence":0.8}]}

Message: "you have credentials in the password manager"
Response: {"signals":[{"type":"correction","domain":"credentials","action_class":"general","suggested_tier":null,"confidence":0.75}]}

Message: "yes that's exactly what I wanted, keep doing that"
Response: {"signals":[{"type":"confirmation","domain":"general","action_class":"general","suggested_tier":null,"confidence":0.95}]}

Message: "what does this regex match"
Response: {"signals":[]}

Message: "write a function that reverses a linked list"
Response: {"signals":[]}`;

export function buildClassifierMessages(text: string): LlmCompleteMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Message: ${JSON.stringify(text)}\nResponse:` },
  ];
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) return fence[1]!.trim();
  return trimmed;
}

function extractJsonObject(raw: string): unknown {
  const stripped = stripFences(raw);
  try {
    return JSON.parse(stripped);
  } catch {
    const first = stripped.indexOf("{");
    const last = stripped.lastIndexOf("}");
    if (first === -1 || last <= first) return null;
    try {
      return JSON.parse(stripped.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

interface RawSignal {
  type?: unknown;
  domain?: unknown;
  action_class?: unknown;
  suggested_tier?: unknown;
  confidence?: unknown;
}

function normalizeSignal(raw: RawSignal, originalText: string): DetectedSignal | null {
  if (typeof raw.type !== "string" || !VALID_TYPES.has(raw.type as FeedbackSignalType)) return null;
  const type = raw.type as FeedbackSignalType;

  const domain = typeof raw.domain === "string" && raw.domain.length > 0 ? raw.domain : "general";
  const action_class = typeof raw.action_class === "string" && raw.action_class.length > 0 ? raw.action_class : "general";
  const confidence = typeof raw.confidence === "number" ? raw.confidence : undefined;

  const signal: DetectedSignal = {
    type,
    domain,
    action_class,
    message: originalText,
    raw_text: originalText,
    source: "llm",
  };

  if (confidence !== undefined) signal.confidence = confidence;

  if (type === "tier_adjustment" && typeof raw.suggested_tier === "string" && VALID_TIERS.has(raw.suggested_tier)) {
    signal.suggested_tier = raw.suggested_tier as DetectedSignal["suggested_tier"];
  }

  return signal;
}

export interface ClassifyOptions {
  minConfidence?: number;
  maxTokens?: number;
  temperature?: number;
  purpose?: string;
}

export async function classifyWithLlm(
  text: string,
  client: LlmClient,
  options: ClassifyOptions = {}
): Promise<DetectedSignal[]> {
  const minConfidence = options.minConfidence ?? 0;
  let result;
  try {
    result = await client.complete({
      messages: buildClassifierMessages(text),
      maxTokens: options.maxTokens ?? 256,
      temperature: options.temperature ?? 0.1,
      purpose: options.purpose ?? "sapience-feedback.classify",
    });
  } catch {
    return [];
  }

  const parsed = extractJsonObject(result.text) as { signals?: RawSignal[] } | null;
  if (!parsed || !Array.isArray(parsed.signals)) return [];

  const signals: DetectedSignal[] = [];
  for (const raw of parsed.signals) {
    const normalized = normalizeSignal(raw, text);
    if (!normalized) continue;
    if (normalized.confidence !== undefined && normalized.confidence < minConfidence) continue;
    signals.push(normalized);
  }
  return signals;
}

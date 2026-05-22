import type { DetectedSignal } from "./types.js";

const CORRECTION_PATTERNS: RegExp[] = [
  /\bdon'?t\b.{0,60}\b(do|update|change|delete|send|push|write|modify|set|use)\b/i,
  /\bstop\b.{0,40}\b(doing|that|this)\b/i,
  /\bnever\b.{0,60}\b(do|update|change|delete|send|push|write)\b/i,
  /\bshouldn'?t\s+(have|be)\b/i,
  /\bwrong\s+(format|approach|template|way)\b/i,
  /\b(use|should use|always use)\s+the\s+\w/i,
];

const TIER_UP_PATTERNS: RegExp[] = [
  /\bjust\s+do\s+it\b/i,
  /\byou\s+don'?t\s+need\s+to\s+ask\b/i,
  /\bgo\s+ahead\s+without\s+asking\b/i,
  /\bdo\s+it\s+automatically\b/i,
];

const TIER_DOWN_PATTERNS: RegExp[] = [
  /\balways\s+ask\s+(me\s+)?(first|before)\b/i,
  /\bask\s+me\s+before\b/i,
  /\bdon'?t\s+do\s+that\s+without\s+(asking|checking)\b/i,
  /\bnext\s+time\s+(check|ask|confirm)\b/i,
];

const CONFIRMATION_PATTERNS: RegExp[] = [
  /\byes[\s,]+exactly\b/i,
  /\bgood\s+call\b/i,
  /\bperfect[,.]?\s*(keep|that'?s|yes)?\b/i,
  /\bkeep\s+doing\s+that\b/i,
  /\bthat'?s\s+(exactly\s+)?right\b/i,
];

const DOMAIN_PATTERNS: Array<[RegExp, string]> = [
  [/github/i, "github"],
  [/salesforce/i, "salesforce"],
  [/posthog/i, "posthog"],
  [/lovable/i, "lovable"],
  [/slack/i, "slack"],
  [/slides?|deck/i, "slides"],
  [/okr/i, "okr-system"],
  [/linear/i, "linear"],
];

function extractDomain(text: string): string {
  for (const [pattern, domain] of DOMAIN_PATTERNS) {
    if (pattern.test(text)) return domain;
  }
  return "general";
}

export function parseMessage(text: string): DetectedSignal[] {
  const signals: DetectedSignal[] = [];
  const domain = extractDomain(text);

  for (const pattern of TIER_UP_PATTERNS) {
    if (pattern.test(text)) {
      signals.push({ type: "tier_adjustment", domain, action_class: "general", message: text, suggested_tier: "act", raw_text: text });
      return signals;
    }
  }

  for (const pattern of TIER_DOWN_PATTERNS) {
    if (pattern.test(text)) {
      signals.push({ type: "tier_adjustment", domain, action_class: "general", message: text, suggested_tier: "ask", raw_text: text });
      return signals;
    }
  }

  for (const pattern of CORRECTION_PATTERNS) {
    if (pattern.test(text)) {
      signals.push({ type: "correction", domain, action_class: "general", message: text, raw_text: text });
      return signals;
    }
  }

  for (const pattern of CONFIRMATION_PATTERNS) {
    if (pattern.test(text)) {
      signals.push({ type: "confirmation", domain, action_class: "general", message: text, raw_text: text });
      return signals;
    }
  }

  return signals;
}

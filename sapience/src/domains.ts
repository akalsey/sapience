// The single domain taxonomy shared (copied per package) by sapience and
// sapience-feedback. These lists used to be duplicated and had drifted, so
// feedback landed on domains routing never emitted — orphaned calibration.
// Extend via plugin config (`domains: { "<regex>": "<slug>" }`); extras are
// checked before builtins so users can override.

export interface DomainPattern {
  pattern: RegExp;
  domain: string;
}

export const DEFAULT_DOMAIN_PATTERNS: DomainPattern[] = [
  { pattern: /github/i, domain: "github" },
  { pattern: /salesforce/i, domain: "salesforce" },
  { pattern: /posthog/i, domain: "posthog" },
  { pattern: /lovable/i, domain: "lovable" },
  { pattern: /slack/i, domain: "slack" },
  { pattern: /google[\s-]?docs?/i, domain: "google-docs" },
  { pattern: /slides?|deck/i, domain: "slides" },
  { pattern: /okr/i, domain: "okr-system" },
  { pattern: /linear/i, domain: "linear" },
  { pattern: /credential|password/i, domain: "credentials" },
];

export function compileExtraDomains(raw: unknown): DomainPattern[] {
  if (!raw || typeof raw !== "object") return [];
  const out: DomainPattern[] = [];
  for (const [pattern, domain] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof domain !== "string" || !domain.trim()) continue;
    try {
      out.push({ pattern: new RegExp(pattern, "i"), domain: domain.trim() });
    } catch { /* invalid regex: skip rather than crash the plugin */ }
  }
  return out;
}

export function extractDomain(text: string, extra: DomainPattern[] = []): string {
  for (const { pattern, domain } of [...extra, ...DEFAULT_DOMAIN_PATTERNS]) {
    if (pattern.test(text)) return domain;
  }
  return "general";
}

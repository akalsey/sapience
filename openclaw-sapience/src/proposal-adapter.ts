import { readFile } from "fs/promises";
import { resolvePath } from "./utils.js";
import type { SapienceItem } from "./types.js";

export interface ProposalSet {
  pass_id: string;
  timestamp: string;
  nothing_to_report: boolean;
  summary: string;
  observations: Array<{ id: string; text: string; evidence: string; priority: number }>;
  proposed_actions: Array<{ id: string; text: string; rationale: string; estimated_effort: string; priority: number }>;
  proposed_audits: Array<{ id: string; domain: string; rationale: string; priority: number }>;
  open_questions: Array<{ id: string; text: string; blocking_what: string }>;
}

const DOMAIN_PATTERNS: Array<[RegExp, string]> = [
  [/github/i, "github"],
  [/salesforce/i, "salesforce"],
  [/posthog/i, "posthog"],
  [/lovable/i, "lovable"],
  [/slack/i, "slack"],
  [/google[\s-]?docs?/i, "google-docs"],
  [/slides?|deck/i, "slides"],
  [/okr/i, "okr-system"],
  [/linear/i, "linear"],
];

export function extractDomain(text: string): string {
  for (const [pattern, domain] of DOMAIN_PATTERNS) {
    if (pattern.test(text)) return domain;
  }
  return "general";
}

export function proposalSetToItems(raw: ProposalSet): SapienceItem[] {
  if (raw.nothing_to_report) return [];
  const items: SapienceItem[] = [];

  for (const obs of raw.observations) {
    const domain = extractDomain(obs.text + " " + obs.evidence);
    items.push({ id: obs.id, type: "observation", text: obs.text, domain, action_class: "observation", priority: obs.priority, pass_id: raw.pass_id, pass_timestamp: raw.timestamp });
  }
  for (const action of raw.proposed_actions) {
    const domain = extractDomain(action.text + " " + action.rationale);
    items.push({ id: action.id, type: "action", text: action.text, domain, action_class: `${domain}/action`, priority: action.priority, pass_id: raw.pass_id, pass_timestamp: raw.timestamp });
  }
  for (const audit of raw.proposed_audits) {
    const domain = extractDomain(audit.domain + " " + audit.rationale);
    items.push({ id: audit.id, type: "audit", text: `${audit.domain}: ${audit.rationale}`, domain, action_class: `${domain}/audit`, priority: audit.priority, pass_id: raw.pass_id, pass_timestamp: raw.timestamp });
  }
  for (const q of raw.open_questions) {
    const domain = extractDomain(q.text + " " + q.blocking_what);
    items.push({ id: q.id, type: "question", text: q.text, domain, action_class: "question", priority: 3, pass_id: raw.pass_id, pass_timestamp: raw.timestamp });
  }
  return items;
}

export async function readUnprocessedPasses(
  proposalsPath: string,
  processedIds: Set<string>
): Promise<ProposalSet[]> {
  try {
    const content = await readFile(resolvePath(proposalsPath), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map(l => JSON.parse(l) as ProposalSet).filter(p => !processedIds.has(p.pass_id));
  } catch { return []; }
}

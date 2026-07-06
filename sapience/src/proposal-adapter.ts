import { readFile } from "fs/promises";
import { resolvePath } from "./utils.js";
import type { SapienceItem } from "./types.js";
import { extractDomain, type DomainPattern } from "./domains.js";

export interface ProposalSet {
  pass_id: string;
  timestamp: string;
  nothing_to_report: boolean;
  summary: string;
  observations: Array<{ id: string; text: string; evidence: string; priority: number; evidence_grade?: "hunch" | "quick_check" | "replicated" }>;
  proposed_actions: Array<{ id: string; text: string; rationale: string; estimated_effort: string; priority: number }>;
  proposed_audits: Array<{ id: string; domain: string; rationale: string; priority: number }>;
  open_questions: Array<{ id: string; text: string; blocking_what: string }>;
}

export { extractDomain } from "./domains.js";

export function proposalSetToItems(raw: ProposalSet, extraDomains: DomainPattern[] = []): SapienceItem[] {
  if (raw.nothing_to_report) return [];
  const items: SapienceItem[] = [];

  for (const obs of raw.observations) {
    const domain = extractDomain(obs.text + " " + obs.evidence, extraDomains);
    items.push({ id: obs.id, type: "observation", text: obs.text, domain, action_class: "observation", priority: obs.priority, pass_id: raw.pass_id, pass_timestamp: raw.timestamp, ...(obs.evidence_grade ? { evidence_grade: obs.evidence_grade } : {}) });
  }
  for (const action of raw.proposed_actions) {
    const domain = extractDomain(action.text + " " + action.rationale, extraDomains);
    items.push({ id: action.id, type: "action", text: action.text, domain, action_class: `${domain}/action`, priority: action.priority, pass_id: raw.pass_id, pass_timestamp: raw.timestamp });
  }
  for (const audit of raw.proposed_audits) {
    const domain = extractDomain(audit.domain + " " + audit.rationale, extraDomains);
    items.push({ id: audit.id, type: "audit", text: `${audit.domain}: ${audit.rationale}`, domain, action_class: `${domain}/audit`, priority: audit.priority, pass_id: raw.pass_id, pass_timestamp: raw.timestamp });
  }
  for (const q of raw.open_questions) {
    const domain = extractDomain(q.text + " " + q.blocking_what, extraDomains);
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
    const passes: ProposalSet[] = [];
    for (const line of lines) {
      try {
        passes.push(JSON.parse(line) as ProposalSet);
      } catch {
        // skip malformed line rather than dropping all proposals
      }
    }
    // proposals.jsonl is append-only and passes are processed in file order,
    // so everything up to the LAST in-set pass has been processed — including
    // older ids the capped processed set has evicted. Without this, evicted
    // ids looked "new" again after ~1000 passes and act-tier proposals from
    // weeks ago re-executed.
    const lastProcessedIdx = passes.reduce(
      (last, p, i) => (processedIds.has(p.pass_id) ? i : last),
      -1
    );
    return passes.slice(lastProcessedIdx + 1).filter(p => !processedIds.has(p.pass_id));
  } catch { return []; }
}

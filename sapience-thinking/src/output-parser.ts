import { randomUUID } from "crypto";
import { Value } from "@sinclair/typebox/value";
import { ProposalSetSchema, type ProposalSet } from "./types.js";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

// The model calls record_thinking_output correctly but is sloppy about the
// exact envelope: it omits pass_id/timestamp (boilerplate it shouldn't have to
// generate), forgets estimated_effort, drops empty arrays, or half-forms an
// item. Rejecting the whole pass over any of that threw away every proposal.
// Instead, be liberal in what we accept: stamp the boilerplate, default the
// envelope, coerce fields, and drop ONLY the items missing genuine content —
// keeping the well-formed ones.

const EFFORTS = new Set(["small", "medium", "large"]);
const GRADES = new Set(["hunch", "quick_check", "replicated"]);

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function clampPriority(v: unknown): 1 | 2 | 3 | 4 | 5 {
  const n = Math.round(typeof v === "number" ? v : Number(v));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n)) as 1 | 2 | 3 | 4 | 5;
}

function itemId(v: unknown): string {
  return typeof v === "string" && v.trim() ? v : randomUUID();
}

function normObservation(raw: any): ProposalSet["observations"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  const text = asString(raw.text).trim();
  if (!text) return null;
  const o: ProposalSet["observations"][number] = {
    id: itemId(raw.id), text, evidence: asString(raw.evidence), priority: clampPriority(raw.priority),
  };
  if (GRADES.has(raw.evidence_grade)) o.evidence_grade = raw.evidence_grade;
  return o;
}

function normAction(raw: any): ProposalSet["proposed_actions"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  const text = asString(raw.text).trim();
  if (!text) return null;
  const a: ProposalSet["proposed_actions"][number] = {
    id: itemId(raw.id), text, rationale: asString(raw.rationale),
    estimated_effort: EFFORTS.has(raw.estimated_effort) ? raw.estimated_effort : "medium",
    priority: clampPriority(raw.priority),
  };
  if (typeof raw.reversible === "boolean") a.reversible = raw.reversible;
  return a;
}

function normAudit(raw: any): ProposalSet["proposed_audits"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  const domain = asString(raw.domain).trim();
  const rationale = asString(raw.rationale).trim();
  if (!domain && !rationale) return null;
  return { id: itemId(raw.id), domain: domain || "general", rationale, priority: clampPriority(raw.priority) };
}

function normQuestion(raw: any): ProposalSet["open_questions"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  const text = asString(raw.text).trim();
  if (!text) return null;
  return { id: itemId(raw.id), text, blocking_what: asString(raw.blocking_what) };
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

export interface NormalizeResult {
  proposals: ProposalSet;
  dropped: number; // malformed items removed during normalization
}

export function normalizeProposals(raw: unknown): NormalizeResult {
  if (!raw || typeof raw !== "object") {
    throw new ParseError(`record_thinking_output expected an object, got ${raw === null ? "null" : typeof raw}`);
  }
  const r = raw as Record<string, unknown>;
  // Unwrap a nested { proposals: {...} } envelope if the model double-wrapped.
  const body = (r.proposals && typeof r.proposals === "object" && !Array.isArray(r.proposals))
    ? (r.proposals as Record<string, unknown>)
    : r;

  let dropped = 0;
  const keep = <T>(items: any[], fn: (x: any) => T | null): T[] => {
    const out: T[] = [];
    for (const it of items) {
      const n = fn(it);
      if (n) out.push(n);
      else dropped++;
    }
    return out;
  };

  const observations = keep(asArray(body.observations), normObservation);
  const proposed_actions = keep(asArray(body.proposed_actions), normAction);
  const proposed_audits = keep(asArray(body.proposed_audits), normAudit);
  const open_questions = keep(asArray(body.open_questions), normQuestion);
  const hasContent = observations.length + proposed_actions.length + proposed_audits.length + open_questions.length > 0;

  const proposals: ProposalSet = {
    pass_id: itemId(body.pass_id),
    timestamp: asString(body.timestamp) || new Date().toISOString(),
    observations,
    proposed_actions,
    proposed_audits,
    open_questions,
    nothing_to_report: typeof body.nothing_to_report === "boolean" ? body.nothing_to_report : !hasContent,
    summary: asString(body.summary),
  };

  // Safety net: normalization should always produce a schema-valid object.
  // If it somehow doesn't, surface the real reason rather than silently passing.
  if (!Value.Check(ProposalSetSchema, proposals)) {
    const detail = [...Value.Errors(ProposalSetSchema, proposals)].map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new ParseError(`Invalid proposal schema after normalization: ${detail}`);
  }
  return { proposals, dropped };
}

export function parseProposals(raw: unknown): ProposalSet {
  return normalizeProposals(raw).proposals;
}

import type { OutcomeMap, ProposalSet } from "./types.js";

// Persistent repeat-guard. The only in-prompt guard is "your last 3 passes" —
// a proposal the user dismissed a few passes ago would happily resurface, and
// a dismissed proposal coming back is the fastest way to teach the user to
// ignore the suite. Compares against outcome-tracker history (which stores
// proposal text as of this feature) with plain token-set similarity.

const DEFAULT_WINDOW_DAYS = 14;
// Exported so the repeat-guard threshold has one source of truth: the same
// notion of "this is the same proposal again" applies whether the duplicate is
// caught before it is queued or after the user has answered its twin.
export const DEFAULT_THRESHOLD = 0.6;

function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
  );
}

interface Overlap { intersection: number; union: number; smaller: number }

function overlap(a: string, b: string): Overlap | null {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return null;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  return {
    intersection,
    union: ta.size + tb.size - intersection,
    smaller: Math.min(ta.size, tb.size),
  };
}

export function similarity(a: string, b: string): number {
  const o = overlap(a, b);
  return o ? o.intersection / o.union : 0;
}

// Jaccard alone under-matches a RESTATEMENT of a situation that hasn't changed.
// Every re-description adds tokens, those extra tokens land in the union, and
// the score falls — so the longer the pass talks about the same stuck thing,
// the less it looks like a repeat.
//
// Production 2026-08-03: once passes could finally read session transcripts,
// an unresolved task got freshly re-observed every 15 minutes and the same
// "I remain in a critical failure loop, unable to answer the user's question
// about AI minutes" reached the user four times in 75 minutes, at priority 5
// each time. Every pair scored 0.243-0.556 — all under the 0.60 bar.
//
// Containment (shared / smaller side) is what catches "B restates A with more
// detail". On its own it would fold anything short into anything long, since a
// six-token fragment shares most of its tokens with unrelated prose, so it
// needs a floor on the smaller side.
//
// sapience's `text-match.ts` carries the same thresholds for the hypothesis
// ledger — separate npm packages can't share a module. They are NOT
// interchangeable: that tokenizer also folds trailing "s", deliberately, since
// case matching runs looser than proposal dedup. Changing one does not change
// the other.
const CONTAINMENT_THRESHOLD = 0.65;
const CONTAINMENT_MIN_TOKENS = 8;

export function isNearDuplicate(a: string, b: string, threshold = DEFAULT_THRESHOLD): boolean {
  const o = overlap(a, b);
  if (!o) return false;
  if (o.intersection / o.union >= threshold) return true;
  return o.smaller >= CONTAINMENT_MIN_TOKENS && o.intersection / o.smaller >= CONTAINMENT_THRESHOLD;
}

export interface DedupOptions {
  windowDays?: number;
  threshold?: number;
}

export function dedupeProposals(
  proposals: ProposalSet,
  outcomes: OutcomeMap,
  opts: DedupOptions = {}
): { kept: ProposalSet; dropped: number } {
  const windowMs = (opts.windowDays ?? DEFAULT_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const cutoff = Date.now() - windowMs;

  const history = Object.values(outcomes)
    .filter((r) => typeof r.text === "string" && r.text.length > 0)
    .filter((r) => new Date(r.created_at).getTime() >= cutoff)
    .map((r) => r.text as string);

  if (history.length === 0) return { kept: proposals, dropped: 0 };

  const isDuplicate = (text: string): boolean =>
    history.some((h) => isNearDuplicate(text, h, threshold));

  let dropped = 0;
  const keep = <T>(items: T[], textOf: (item: T) => string): T[] =>
    items.filter((item) => {
      if (isDuplicate(textOf(item))) { dropped++; return false; }
      return true;
    });

  const kept: ProposalSet = {
    ...proposals,
    observations: keep(proposals.observations, (o) => o.text),
    proposed_actions: keep(proposals.proposed_actions, (a) => a.text),
    proposed_audits: keep(proposals.proposed_audits, (a) => `${a.domain}: ${a.rationale}`),
    open_questions: keep(proposals.open_questions, (q) => q.text),
  };
  return { kept, dropped };
}

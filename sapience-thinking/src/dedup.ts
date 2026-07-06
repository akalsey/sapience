import type { OutcomeMap, ProposalSet } from "./types.js";

// Persistent repeat-guard. The only in-prompt guard is "your last 3 passes" —
// a proposal the user dismissed a few passes ago would happily resurface, and
// a dismissed proposal coming back is the fastest way to teach the user to
// ignore the suite. Compares against outcome-tracker history (which stores
// proposal text as of this feature) with plain token-set similarity.

const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_THRESHOLD = 0.6;

function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
  );
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
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
    history.some((h) => similarity(text, h) >= threshold);

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

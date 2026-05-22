import type { OutcomeMap, SignalReport, PluginConfig } from "./types.js";

export function computeSignal(outcomes: OutcomeMap, config: PluginConfig): SignalReport | null {
  const records = Object.values(outcomes);
  if (records.length === 0) return null;

  const earliest = records.reduce((min, r) =>
    new Date(r.created_at) < new Date(min.created_at) ? r : min
  );
  const ageDays = (Date.now() - new Date(earliest.created_at).getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays < config.learning.bootstrapDays) return null;

  const byType = (type: string) => records.filter((r) => r.proposal_type === type);
  const resolved = (recs: typeof records) =>
    recs.filter((r) => r.state !== "pending" && r.state !== "expired");
  const actedOn = (recs: typeof records) =>
    recs.filter((r) => r.state === "acted_on" || r.state === "accepted");

  const obss = byType("observation");
  const actions = byType("action");
  const audits = byType("audit");
  const questions = byType("question");

  return {
    observations: { total: obss.length, reviewed: resolved(obss).length, acted_on: actedOn(obss).length },
    actions: {
      total: actions.length,
      acted_on: actedOn(actions).length,
      rejected: actions.filter((r) => r.state === "rejected").length,
    },
    audits: { total: audits.length, accepted: actedOn(audits).length },
    questions: {
      total: questions.length,
      answered: questions.filter((r) =>
        r.state === "acknowledged" || r.state === "acted_on" || r.state === "accepted"
      ).length,
    },
    computed_at: new Date().toISOString(),
  };
}

import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

// Analytical playbooks: the analyst moves a thinking pass applies whenever it
// has data in hand. Builtins encode the non-negotiables; users teach new ones
// through method feedback ("whenever you look at churn, segment by plan tier"),
// which sapience-feedback appends to the shared playbooks file.

export interface Playbook {
  id: string;
  title: string;
  instruction: string;
  source?: "builtin" | "feedback";
  added_at?: string;
}

export const BUILTIN_PLAYBOOKS: Playbook[] = [
  {
    id: "decompose-on-delta",
    title: "Decompose on delta",
    instruction: "When an aggregate metric moved, decompose before reporting: is the change broad-based or concentrated? Check top-contributor share — 'voice minutes up 40%' means something different when one customer drives it.",
    source: "builtin",
  },
  {
    id: "outlier-check",
    title: "Outlier check",
    instruction: "When looking at any distribution or list, check whether a single outlier dominates before describing the average or the trend.",
    source: "builtin",
  },
  {
    id: "denominator-check",
    title: "Denominator check",
    instruction: "For every rate or percentage, confirm the denominator: what population, what window, did it change? A conversion rate that 'improved' on a shrunken denominator is not an improvement.",
    source: "builtin",
  },
  {
    id: "seasonality-check",
    title: "Seasonality check",
    instruction: "Before flagging a change as meaningful, compare against the same weekday/period historically — Mondays, month-ends, and holidays have their own baselines.",
    source: "builtin",
  },
  {
    id: "case-to-cohort",
    title: "Case to cohort",
    instruction: "When a single case shows an interesting pattern (one customer's usage decayed before churn), ask whether it generalizes: could this hold across the whole population? Flag the hypothesis even when you can't test it now.",
    source: "builtin",
  },
];

export async function loadPlaybooks(path: string): Promise<Playbook[]> {
  const user = await readJsonSafe<Playbook[]>(path, []);
  return [...BUILTIN_PLAYBOOKS, ...(Array.isArray(user) ? user : [])];
}

function normalize(instruction: string): string {
  return instruction.trim().toLowerCase().replace(/\s+/g, " ");
}

// Returns null when an equivalent playbook already exists.
export async function addPlaybook(path: string, instruction: string, title?: string): Promise<Playbook | null> {
  const trimmed = instruction.trim();
  if (!trimmed) return null;
  const existing = await loadPlaybooks(path);
  if (existing.some((p) => normalize(p.instruction) === normalize(trimmed))) return null;

  const user = await readJsonSafe<Playbook[]>(path, []);
  const playbook: Playbook = {
    id: `taught-${Date.now().toString(36)}`,
    title: title ?? trimmed.slice(0, 60),
    instruction: trimmed,
    source: "feedback",
    added_at: new Date().toISOString(),
  };
  await writeJsonAtomic(path, [...user, playbook]);
  return playbook;
}

export function renderPlaybooks(playbooks: Playbook[]): string {
  return playbooks.map((p) => `- ${p.instruction}`).join("\n");
}

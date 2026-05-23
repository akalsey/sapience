import type { Goal } from "./types.js";

export function buildDecompositionPrompt(description: string): string {
  return `[GOALS: DECOMPOSE] A new goal was submitted. Decompose it into candidate approaches and present them to the user for selection.

Goal: "${description}"

Your job:
1. Think about what you could realistically do toward this goal given your available tools and access.
2. Identify 2–4 concrete approaches. For each: describe what you'd do, what tools you'd use, what you could accomplish without human input, and what you'd need from the human to make progress.
3. Present the approaches to the user and ask them to pick one (or say "none of these").

Keep it practical. Only propose approaches you can actually execute with your current tools. Don't promise what you can't deliver.`;
}

export function buildWeeklyStatusPrompt(goal: Goal): string {
  const recentNotes = goal.progress_notes.slice(-3);
  const progressText = recentNotes.length > 0
    ? recentNotes.map(n => `- ${n.timestamp.slice(0, 10)}: ${n.summary}\n  (${n.what_changed})`).join("\n")
    : "No progress logged yet.";

  const blockerText = goal.blockers.length > 0
    ? goal.blockers.map(b => `- ${b.description} (waiting on: ${b.waiting_on})`).join("\n")
    : "None.";

  return `[GOALS: WEEKLY STATUS] Deliver a weekly status update for this goal.

Goal: "${goal.description}"
Active approach: ${goal.active_approach || "(not yet selected)"}
Status: ${goal.status}

Recent progress:
${progressText}

Current blockers:
${blockerText}

Deliver a brief status update to the user covering:
- What happened toward this goal this week
- What's currently blocked and what would unblock it
- What you plan to try next week
- Any questions you need answered to make progress

Be concise. If there's nothing new to report, say so briefly.`;
}

export async function deliverDecomposition(description: string, api: any): Promise<void> {
  await api.session.workflow.enqueueNextTurnInjection({
    sessionTarget: "main",
    text: buildDecompositionPrompt(description),
  });
}

export async function deliverWeeklyStatus(goal: Goal, api: any): Promise<void> {
  await api.session.workflow.enqueueNextTurnInjection({
    sessionTarget: "main",
    text: buildWeeklyStatusPrompt(goal),
  });
}

import type { ContextBundle, SignalReport } from "./types.js";
import { THINKING_PROMPT, HEARTBEAT_PROMPT } from "./prompts.js";

function pct(n: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`;
}

function formatSignal(signal: SignalReport): string {
  return [
    "## Your Recent Proposal Signal-to-Noise",
    "",
    `- Observations: ${pct(signal.observations.reviewed, signal.observations.total)} reviewed, ${pct(signal.observations.acted_on, signal.observations.total)} acted on`,
    `- Proposed actions: ${pct(signal.actions.acted_on, signal.actions.total)} acted on, ${pct(signal.actions.rejected, signal.actions.total)} rejected`,
    `- Proposed audits: ${pct(signal.audits.accepted, signal.audits.total)} accepted`,
    `- Open questions: ${pct(signal.questions.answered, signal.questions.total)} answered`,
    "",
    "Use this signal to calibrate. Be more selective in categories with low acceptance.",
  ].join("\n");
}

export function buildPrompt(bundle: ContextBundle, signal: SignalReport | null): string {
  const sections: string[] = [THINKING_PROMPT];

  sections.push(["## Recent Activity Context", "", bundle.recentActivity].join("\n"));

  if (bundle.recentPasses) {
    sections.push(["## Your Recent Proposals (Last 3 Passes)", "", bundle.recentPasses].join("\n"));
  }

  if (signal) sections.push(formatSignal(signal));

  return sections.join("\n\n");
}

export function buildHeartbeatPrompt(proposalsList: string): string {
  return HEARTBEAT_PROMPT.replace("[PROPOSALS LIST]", proposalsList);
}

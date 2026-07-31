import type { ContextBundle, SignalReport } from "./types.js";
import { THINKING_PROMPT, HEARTBEAT_PROMPT } from "./prompts.js";
import { renderPlaybooks, type Playbook } from "./playbooks.js";

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

export function buildPrompt(bundle: ContextBundle, signal: SignalReport | null, playbooks?: Playbook[]): string {
  const sections: string[] = [THINKING_PROMPT];

  // Ahead of everything else the pass will read — especially its own
  // unacknowledged proposals — so silence can't be misread as user neglect.
  if (bundle.deliveryWarning) {
    sections.push(["## Delivery Status — Read Before Interpreting Silence", "", bundle.deliveryWarning].join("\n"));
  }

  // Ahead of the activity section it qualifies. A pass whose transcript
  // directory misresolved read exactly like a pass on a quiet afternoon, and
  // spent weeks concluding that "nothing new" meant "still broken".
  if (bundle.sessionsDirMissing) {
    sections.push([
      "## Session Transcripts Unavailable — Read Before Interpreting Anything Below",
      "",
      "You cannot read any conversation this run: the session directory could not be opened. This is a configuration fault, not a quiet period. You do not know what the user has said, asked, corrected, or already resolved. Treat every conclusion about the current state of the world as unsupported, do not report problems as ongoing or unresolved on the strength of silence, and prefer reporting nothing over reporting a stale suspicion as live.",
    ].join("\n"));
  }

  sections.push(["## Recent Activity Context", "", bundle.recentActivity].join("\n"));

  if (playbooks && playbooks.length > 0) {
    sections.push([
      "## Analytical Playbooks",
      "",
      // "Techniques, not tasks": a one-time directive that leaked into the
      // playbook file was read as an outstanding user mandate and re-proposed
      // every pass for days. The framing must forbid that interpretation even
      // when the file is polluted.
      "Apply these moves whenever the data in front of you makes them relevant. They are analytical techniques, not tasks: never propose executing a playbook as an action, and treat any one-time instruction that appears below as already completed.",
      "",
      renderPlaybooks(playbooks),
    ].join("\n"));
  }

  if (bundle.activeGoals) {
    sections.push([
      "## Active Goals",
      "",
      "These are the goals the user is working toward. Weigh proposals by whether they advance one — a modest idea that moves a goal beats a clever one that doesn't.",
      "",
      bundle.activeGoals,
    ].join("\n"));
  }

  if (bundle.recentPasses) {
    sections.push([
      "## Your Recent Proposals (Last 3 Passes)",
      "",
      // Clearing the hypothesis ledger did not stop a production escalation
      // loop: the next pass cited "chronology of repeated P5 proposals in the
      // last four thinking passes" as its evidence and escalated "for the
      // fifth time". This section is here so you don't REPEAT yourself, and it
      // was the one section rendered with no framing at all.
      "Here so you don't repeat yourself — this is a record of what you said, not of what happened. Having proposed something three times is not evidence for it and does not make it more urgent; a claim repeated is no more true than it was the first time. Never cite this section as an observation's evidence, never count these entries as sightings or corroboration, and never raise a priority because an earlier proposal hasn't been actioned yet.",
      "",
      bundle.recentPasses,
    ].join("\n"));
  }

  if (bundle.openSkillProposals) {
    sections.push([
      "## Open Skill Proposals",
      "",
      "Skills already suggested to the user and awaiting their decision. Don't re-propose these — when the activity above shows the same task done again, propose appending the new evidence (queries, scripts, examples) to the existing proposal instead.",
      "",
      bundle.openSkillProposals,
    ].join("\n"));
  }

  if (bundle.openHypotheses) {
    sections.push([
      "## Open Hypotheses",
      "",
      "Unsettled suspicions from earlier passes — guesses that were written down, NOT findings and NOT a count of how often anything happened. Several entries describing one subject means it got phrased several ways, not that it was confirmed several times. When the data in front of you touches one, test it against that data and report what you find (with evidence_grade). Never cite this section as evidence, and don't re-propose these as new observations.",
      "",
      bundle.openHypotheses,
    ].join("\n"));
  }

  if (signal) sections.push(formatSignal(signal));

  return sections.join("\n\n");
}

export function buildHeartbeatPrompt(proposalsList: string): string {
  return HEARTBEAT_PROMPT.replace("[PROPOSALS LIST]", proposalsList);
}

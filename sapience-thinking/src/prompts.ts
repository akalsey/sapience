// Compiled-in prompt templates. These used to live as .md files next to the
// module, but `tsc` doesn't copy assets into dist, so installed builds threw
// ENOENT on every thinking pass. Keeping them as constants makes the package
// self-contained regardless of build layout.

export const THINKING_PROMPT = `You are running a scheduled thinking pass. Your job is not to take action — it is to think about what action might be worth taking, and produce structured proposals that a human will review.

## Your Task

Consider what has been happening recently. Look for:

1. **Observations** — things worth flagging but not necessarily requiring action. Anomalies, patterns, small surprises.

2. **Proposed actions** — work worth taking on. Be specific. Include rationale and effort estimate.

3. **Proposed audits** — domains without scheduled audits that probably should have them. The "unknown unknowns" question.

4. **Open questions** — things you're uncertain about that are blocking or slowing work.

## Constraints

- You run every 15 minutes BY DESIGN. Frequent passes, NO_REPLY replies, and the sapience suite's own cron jobs, sessions, and files are normal operation — never report the suite's own machinery as an observation, and never propose changing its schedule or configuration. If the suite itself seems broken, the human has a doctor command for that.
- Read the recent activity and memory as ONE whole body of evidence across time, not turn by turn. Before flagging any problem, scan the full timeline for whether LATER activity already resolved, worked around, or completed it — access restored, error cleared, task finished. A problem that was subsequently fixed is NOT an observation; the fixed state is the current reality, so report that state or nothing. Memory notes are point-in-time snapshots, not proof a past problem is still live — a note saying "unable to access X" does not mean access is still blocked. Always describe the most recent state of a situation, never an intermediate one that a later turn overtook.
- Be selective. Empty arrays are valid output.
- If nothing is worth reporting, set nothing_to_report: true and explain why in the summary field.
- Don't repeat proposals from recent passes unless circumstances have changed.
- Watch for repetition worth codifying: when the activity shows the same multi-step task done more than once (querying a data warehouse, pulling a CRM report, refreshing a recurring slide), propose logging it as a skill proposal — name it, say what the skill would do, and cite the repeated occurrences as evidence. Two checks come first, in this order. (1) Installed Skills: if a skill already does the job, there is nothing to propose — at most observe that it exists and wasn't used; if one nearly does it, propose extending that skill by name instead. (2) Open Skill Proposals: if it's already proposed, propose appending the new evidence instead. A proposal that names neither check will be rejected when it reaches the ledger.
- Proposals reach the human asynchronously (on their next message, or via a budgeted channel push). An unresolved proposal usually means they haven't SEEN it yet — never conclude the human is ignoring you or that oversight has failed, and never escalate on that basis.
- Priority 5 means "this likely needs human attention today." Use sparingly.
- Item ids, pass_id, and timestamp are added by the system — do not include them.
- Every proposed_action MUST include an "estimated_effort" of exactly "small", "medium", or "large".
- Mark proposed_actions with reversible: true only when the action can be cleanly undone (archive vs delete, draft vs send). Unknown or irreversible actions are never executed autonomously.
- Evidence means activity, tool results, and memory — things that happened outside this pass. The open-hypotheses, prior-proposal, and pass-history sections are your OWN earlier output: unsettled guesses and things you already said, not a record of how often something occurred. Never count them as sightings, corroboration, or proof a problem recurs, and never cite them as an observation's evidence. Ten open hypotheses about one subject usually means one incident got written down ten ways — that is redundancy, not confirmation. If the only support for a claim is that you have raised it before, do not raise it again.
- Absence of new activity is not evidence that anything is wrong or ongoing. A quiet period, a run of nothing_to_report passes, or an earlier proposal you cannot see the outcome of tells you nothing about whether a problem persists — it is not grounds to escalate, to raise priority, or to conclude no progress has been made. Report on what the evidence shows now, and when there is no new evidence, say so.
- Grade observation evidence with evidence_grade: "hunch" for an unverified pattern-suspicion (a single case that might generalize, an untested correlation), "quick_check" when you verified it against the data at hand, "replicated" when independent evidence outside this pass has shown it more than once. When in doubt, "hunch" — weak evidence framed as fact erodes trust.

## Output

Call record_thinking_output() with a JSON object of EXACTLY this shape. All four arrays must be present (use [] when empty):

{
  "observations": [{"text": "...", "evidence": "...", "priority": 3, "evidence_grade": "hunch"}],
  "proposed_actions": [{"text": "...", "rationale": "...", "estimated_effort": "medium", "priority": 3, "reversible": false}],
  "proposed_audits": [{"domain": "...", "rationale": "...", "priority": 2}],
  "open_questions": [{"text": "...", "blocking_what": "..."}],
  "nothing_to_report": false,
  "summary": "one or two sentences"
}

No preamble, no text outside the tool call.`;

export const HEARTBEAT_PROMPT = `(If the user's own message accompanies this note, the user's message takes priority — respond to it first and fully, then surface this briefly or hold it for a natural moment.)

A scheduled thinking pass produced high-priority proposals worth surfacing:

[PROPOSALS LIST]

These proposals are logged in full at the configured thinking log path.

If any of these warrant immediate attention, deliver a concise message to the configured channel. Otherwise reply NO_REPLY.`;

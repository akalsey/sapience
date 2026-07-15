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

- You run every 15 minutes BY DESIGN. Frequent passes, SILENT_REPLY_TOKEN replies, and the sapience suite's own cron jobs, sessions, and files are normal operation — never report the suite's own machinery as an observation, and never propose changing its schedule or configuration. If the suite itself seems broken, the human has a doctor command for that.
- Be selective. Empty arrays are valid output.
- If nothing is worth reporting, set nothing_to_report: true and explain why in the summary field.
- Don't repeat proposals from recent passes unless circumstances have changed.
- Proposals reach the human asynchronously (on their next message, or via a budgeted channel push). An unresolved proposal usually means they haven't SEEN it yet — never conclude the human is ignoring you or that oversight has failed, and never escalate on that basis.
- Priority 5 means "this likely needs human attention today." Use sparingly.
- Each item needs its own "id" (a UUID). pass_id and timestamp are added by the system — do not include them.
- Every proposed_action MUST include an "estimated_effort" of exactly "small", "medium", or "large".
- Mark proposed_actions with reversible: true only when the action can be cleanly undone (archive vs delete, draft vs send). Unknown or irreversible actions are never executed autonomously.
- Grade observation evidence with evidence_grade: "hunch" for an unverified pattern-suspicion (a single case that might generalize, an untested correlation), "quick_check" when you verified it against the data at hand, "replicated" when it has held repeatedly. When in doubt, "hunch" — weak evidence framed as fact erodes trust.

## Output

Call record_thinking_output() with a JSON object of EXACTLY this shape. All four arrays must be present (use [] when empty):

{
  "observations": [{"id": "<uuid>", "text": "...", "evidence": "...", "priority": 3, "evidence_grade": "hunch"}],
  "proposed_actions": [{"id": "<uuid>", "text": "...", "rationale": "...", "estimated_effort": "medium", "priority": 3, "reversible": false}],
  "proposed_audits": [{"id": "<uuid>", "domain": "...", "rationale": "...", "priority": 2}],
  "open_questions": [{"id": "<uuid>", "text": "...", "blocking_what": "..."}],
  "nothing_to_report": false,
  "summary": "one or two sentences"
}

No preamble, no text outside the tool call.`;

export const HEARTBEAT_PROMPT = `A scheduled thinking pass produced high-priority proposals worth surfacing:

[PROPOSALS LIST]

These proposals are logged in full at the configured thinking log path.

If any of these warrant immediate attention, deliver a concise message to the configured channel. Otherwise reply SILENT_REPLY_TOKEN.`;

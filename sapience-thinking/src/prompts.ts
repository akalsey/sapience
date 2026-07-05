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

- Be selective. Empty arrays are valid output.
- If nothing is worth reporting, set nothing_to_report: true and explain why in the summary field.
- Don't repeat proposals from recent passes unless circumstances have changed.
- Priority 5 means "this likely needs human attention today." Use sparingly.
- All proposal IDs must be UUIDs (use crypto.randomUUID() format).

## Output

Call record_thinking_output() with valid JSON matching the ProposalSet schema. No preamble, no explanation outside the tool call.`;

export const HEARTBEAT_PROMPT = `A scheduled thinking pass produced high-priority proposals worth surfacing:

[PROPOSALS LIST]

These proposals are logged in full at the configured thinking log path.

If any of these warrant immediate attention, deliver a concise message to the configured channel. Otherwise reply SILENT_REPLY_TOKEN.`;

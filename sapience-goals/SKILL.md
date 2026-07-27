# Using sapience-goals

## When to submit a goal

Call `goal_submit` when the user expresses a fuzzy, long-running objective — something that can't be finished in one session and doesn't have an obvious single action:

- "I want to improve our OKR scoring rate"
- "We need to get better signal on what's blocking engineers"
- "Figure out why our PostHog costs keep spiking"
- "Help me build a habit of writing weekly team updates"

**Don't** submit routine tasks, one-off requests, or things that are already well-defined tickets. Goals are directions, not tasks.

## How to submit

Call `goal_submit(description)` with the user's objective as stated — fuzzy language is fine. You don't need to clean it up or restate it formally.

## What happens next — in the same turn

`goal_submit` returns the goal id and a script for the rest of *this* turn. Don't stop at "recorded, I'll come back with approaches", and don't start doing the work: the goal is long-running, pursued by scheduled thinking passes over weeks.

1. Acknowledge the goal in your own words, as an ongoing commitment.
2. Ask one or two clarifying questions if the metric, cadence, or definition of done is ambiguous.
3. Propose 2–3 concrete **recurring** approaches — what you'd watch, gather, or do on a cadence — and wait for the user's pick.

When they pick, call `goal_select_approach(id, approach)`; the goal stays in `decomposing` (no weekly check-ins) until you do. Goals written to the inbox file (`goals/inbox.md`) instead are picked up by the next `check_goals` cron run, which delivers a `[GOALS: DECOMPOSE]` prompt.

Lost the id in a later turn? Call `goal_list()` — never guess one.

## Compile the approach into a plan

Right after the approach is settled, call `goal_plan(id, instructions, todos)`:

- `instructions` — standing behavioral instructions to follow during normal work while this goal is active ("when you access PostHog, remember the results; compare against what you know; explain trends and outliers; don't force conclusions"). These are installed as a temporary workspace skill, active in every session.
- `todos` — the initial concrete steps toward the outcome.

Then keep the list alive with `goal_todo(id, "add"|"done", text)`: add todos as new work becomes clear, mark them done as they finish. When the last open todo is completed, confirm with the user whether the outcome is actually reached — if yes, `goal_update(id, "completed")` (which retires the temporary skill); if not, add the next todos. Only when the goal produced a recurring analysis worth repeating should you suggest a permanent skill: log the spec with `skill_proposal` if that tool is available, otherwise describe it. Many goals simply end.

## Ongoing lifecycle

- `goal_progress(id, summary, what_changed)` — call whenever meaningful work toward an active goal happens
- `goal_blocker(id, description, waiting_on)` — call when something blocks progress
- `goal_update(id, status)` — status transitions: `active`, `paused`, `completed`, `abandoned`
- `goal_set_metric(id, name, target, unit?, query_hint?, baseline?)` — call when the user states (or agrees to) a measurable key result for a goal: "measure this by SMB churn, target 5%". Include a `query_hint` for where to fetch the current value and a `baseline` when known, so pace can be computed

## Weekly check-ins

Every Monday (or the configured day), goals with status `active` receive a `[GOALS: WEEKLY STATUS]` prompt. You report what happened, what's blocked, and what's planned next. Keep it brief — if nothing happened, say so.

When the goal has a metric, the prompt tells you to fetch the current value first and lead with it: current value, percent of target, and whether the pace to target is on track. Numbers before narrative.

## When NOT to submit

- The user is describing a task they want done now → just do it
- The user mentions something in passing without expressing intent → don't submit without confirming
- The goal is already in the active list → update it, don't duplicate

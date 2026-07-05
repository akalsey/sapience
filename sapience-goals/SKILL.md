# Using sapience-goals

## When to submit a goal

Call `goal_submit` when the user expresses a fuzzy, long-running objective — something that can't be finished in one session and doesn't have an obvious single action:

- "I want to improve our OKR scoring rate"
- "We need to get better signal on what's blocking engineers"
- "Figure out why our PostHog costs keep spiking"
- "Help me build a habit of writing weekly team updates"

**Don't** submit routine tasks, one-off requests, or things that are already well-defined tickets. Goals are directions, not tasks.

## How to submit

Call `goal_submit(description)` with the user's objective as stated — fuzzy language is fine. You don't need to clean it up or restate it formally. The system handles decomposition.

After submitting, confirm to the user: "I've recorded that as a goal and will come back with some approaches."

## What happens next

`goal_submit` delivers a `[GOALS: DECOMPOSE]` prompt immediately — it's injected into the main session's next turn, presenting 2–4 concrete approaches. When the user picks one, call `goal_select_approach(id, approach)` to record it; the goal stays in `decomposing` (no weekly check-ins) until you do. Goals written to the inbox file (`goals/inbox.md`) instead are picked up by the next `check_goals` cron run.

## Ongoing lifecycle

- `goal_progress(id, summary, what_changed)` — call whenever meaningful work toward an active goal happens
- `goal_blocker(id, description, waiting_on)` — call when something blocks progress
- `goal_update(id, status)` — status transitions: `active`, `paused`, `completed`, `abandoned`

## Weekly check-ins

Every Monday (or the configured day), goals with status `active` receive a `[GOALS: WEEKLY STATUS]` prompt. You report what happened, what's blocked, and what's planned next. Keep it brief — if nothing happened, say so.

## When NOT to submit

- The user is describing a task they want done now → just do it
- The user mentions something in passing without expressing intent → don't submit without confirming
- The goal is already in the active list → update it, don't duplicate

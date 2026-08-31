# OpenClaw Goals

Some things worth doing aren't tasks. They're directions — fuzzy, long-running, and valuable even when the path isn't clear. "Our teams aren't scoring OKRs regularly" is a goal, not a ticket.

This plugin accepts those kinds of objectives, talks through candidate approaches, compiles the one you pick into standing instructions the agent follows in every session, tracks incremental progress against a todo list it maintains itself, and delivers a weekly status update. You stay oriented without managing the detail.

This plugin is part of the Sapience Suite that gives your OpenClaw agent genuine agency — not just the ability to execute tasks, but the judgment to know when to act, when to ask, when to propose, and when to say "I'm not sure how you want me to handle this."

This plugin can be used without Sapience if all you want to do is track multi-step tasks.

---

## Setup

### Install

```bash
openclaw plugins install npm:@akalsey/sapience-goals
```

### Configuration

Config lives under `plugins.entries.sapience-goals.config` — the full path shape; the short `plugins.sapience-goals` form is silently ignored.

```json
{
  "plugins": {
    "entries": {
      "sapience-goals": {
        "config": {
          "weeklyCheckInDay": "monday",
          "weeklyCheckInTime": "09:00",
          "activeHours": {
            "start": "08:00",
            "end": "20:00",
            "timezone": "America/Los_Angeles"
          },
          "inboxPath": "goals/inbox.md",
          "skillsDir": "skills"
        }
      }
    }
  }
}
```

All settings are optional — defaults above are used if omitted. Relative paths resolve under the agent workspace dir (`<workspace>/`); absolute and `~/` paths are honored. Invalid `activeHours` values fall back to defaults and emit a `config_invalid` event. On installs where `session.dmScope` makes the agent main session machine-only, set `delivery.sessionKey` so decomposition and status prompts land where you'll see them ([docs/configuration.md](../docs/configuration.md#delivery-target)). Full key reference: [docs/configuration.md](../docs/configuration.md).

### Output files

| File | Purpose |
|------|---------|
| `<workspace>/goals/goals.json` | All goals with status, approaches, instructions, todos, progress, blockers |
| `<workspace>/goals/inbox.md` | Where you (or scripts) write new goals |
| `<workspace>/goals/inbox-position.json` | Byte offset tracking — don't edit this |
| `<workspace>/skills/goal-<id>/SKILL.md` | A goal's standing instructions as a temporary skill — written by `goal_plan`, removed when the goal completes or is abandoned |

---

## Submitting a goal

Just tell the agent in conversation:

> "I want to improve our OKR scoring rate"
> "Figure out why PostHog costs keep spiking"
> "Help me build a habit of writing weekly team updates"

The agent recognizes long-running objectives and calls `goal_submit` automatically — and then keeps talking, **in that same turn**. It acknowledges the goal as an ongoing commitment (not a task to start on now), asks one or two clarifying questions if what "done" looks like is ambiguous, and proposes 2–3 concrete recurring approaches for you to choose from. You get the planning conversation you expected in the reply to your own message, not an injected prompt later.

### Via the inbox file (scripting/external use)

You can also append goals directly to the inbox file for use from scripts or other tools:

```bash
echo "Our teams aren't scoring OKRs regularly — improve that" >> <workspace>/goals/inbox.md
```

The next `check_goals` cron run (within 15 minutes, during active hours) picks it up. The plugin won't error if the file is missing — create it when you need it.

---

## Decomposition

Goals written to the **inbox file** are decomposed asynchronously: the next `check_goals` cron run delivers a `[GOALS: DECOMPOSE]` prompt to your session:

> "I noticed this goal: 'Our teams aren't scoring OKRs regularly.' Here are 3 approaches I could take…"

It presents 2–4 concrete approaches, explains what each would accomplish and what it would need from you, and asks you to pick one (or none). Goals submitted in conversation get the same content immediately, in the submission turn.

When you pick, the agent calls `goal_select_approach` — that records your pick as the `active_approach` and moves the goal to `active`. Goals without a selected approach stay in `decomposing` status and don't receive weekly updates until you pick one.

---

## A goal is a temporary skill

Picking an approach isn't the end of planning. The agent compiles it into **standing instructions** — how it should behave during normal work while this goal is live ("when you pull PostHog numbers, keep the results, compare against what you already know, explain trends and outliers, don't force conclusions") — and seeds an initial todo list, both saved with `goal_plan`.

The instructions are written to `<workspace>/skills/goal-<id>/SKILL.md` as a real workspace skill, so they're active in every session exactly like a hand-written one. Don't hand-edit that file: it's regenerated from the goal, and retired automatically when the goal is completed or abandoned.

From there the todo list is the plan. The agent adds todos as new work becomes clear and marks them done as it finishes them (`goal_todo`); thinking passes see each active goal's open todos and propose work that moves them. Completing the last open todo starts wrap-up: the agent confirms with you whether the outcome is actually reached, then either completes the goal (`goal_update`, which retires the skill) or adds the next todos. Only when a goal produced a recurring analysis worth repeating does it suggest a permanent skill — via `skill_proposal` when sapience is installed. Many goals simply end.

---

## Goal lifecycle tools

The plugin registers ten tools the agent calls in conversation — you never invoke these directly, just talk:

| Tool | Does |
|------|------|
| `goal_submit(description)` | Creates a goal in `decomposing` status and scripts the same-turn planning conversation |
| `goal_list()` | Lists every goal with id, status, approach, and open todos — how the agent finds an id in a later session |
| `goal_select_approach(id, approach)` | Records the approach you picked and marks the goal `active` |
| `goal_plan(id, instructions, todos?)` | Saves standing instructions (installed as the temporary skill) and seeds the todo list |
| `goal_todo(id, action, text)` | Adds a todo or marks one done; emptying the list starts wrap-up |
| `goal_update(id, status)` | Status transitions: `active`, `paused`, `completed`, `abandoned` (the last two retire the skill) |
| `goal_progress(id, summary, what_changed?)` | Records a progress note when meaningful work toward the goal happens |
| `goal_blocker(id, description, waiting_on?)` | Records something blocking progress |
| `goal_set_metric(id, name, target, unit?, query_hint?, baseline?)` | Attaches a measurable key result — weekly statuses then compute progress from data instead of narration |
| `check_goals()` | Called by the cron: reads the inbox and delivers due weekly statuses |

So "mark the OKR goal complete" or "measure this by SMB churn rate, target 5%" work as plain conversation. `goals.json` is still plain JSON if you prefer to edit directly.

Note that OpenClaw core registers its own `create_goal` / `get_goal` / `update_goal`. Those track a per-thread token budget and expire with the session — unrelated to the goals here, despite the names. If a goal you asked for vanished by the next session, the agent probably reached for `create_goal` instead of `goal_submit`.

---

## Weekly status

Every Monday at 9am (or your configured day/time), goals with `status: "active"` get a `[GOALS: WEEKLY STATUS]` prompt delivered to your main session's next turn:

> "Weekly status for 'Improve OKR scoring rates':
> - What happened this week: …
> - What's blocked: …
> - What I plan next week: …"

Each goal gets its own delivery. If nothing happened and nothing is blocked, the agent says so briefly and doesn't pad.

Goals with a metric attached (`goal_set_metric`) get an instrumented status: the agent fetches the current value first (using the metric's `query_hint`) and **leads with the numbers** — current value, percent of target, and whether the pace to target is on track — before the narrative.

The next delivery date is stored per-goal in `goals.json` and rolls forward automatically after each successful delivery. If an injection fails, a `delivery_failed` event is recorded and the status is retried on the next run rather than silently skipping a week.

---

## Troubleshooting

**Goal submitted in conversation but no approaches offered**
Goals submitted via `goal_submit` are planned in the same turn — if the agent recorded the goal and stopped, it ignored the tool result. Ask it directly for approaches; `goal_list` gives it the id. Inbox goals are different: their `[GOALS: DECOMPOSE]` prompt is a next-turn injection, so it appears the next time you take a turn. If it never does, look for `delivery_failed` events in `<workspace>/sapience/events.jsonl`.

**The agent says it can't find the goal / "trouble with the goal_select_approach tool"**
Every goal tool needs an id. `goal_list` is how the agent retrieves one in a later turn or session — if it's flailing, tell it to list the goals first.

**Inbox goal not picked up**
Inbox goals are read by the `check_goals` cron, which fires every 15 minutes during active hours. Wait for the next pass, or trigger manually:
```bash
openclaw cron run sapience-goals-check
```
Also confirm the inbox path matches your config and that the file is readable. `openclaw sapience doctor` shows the resolved paths.

**Same goals showing up again after re-install**
The byte-position tracker (`inbox-position.json`) tracks what's been read. If it's missing, the inbox is read from the beginning. Delete old content from the inbox file, or manually set the position to the file's current byte length.

**Weekly status not delivering**
Check `goals.json` — the goal must have `status: "active"` and `next_status_delivery` must be a past date. If `active_approach` is empty, the goal is still in `decomposing` status and won't get weekly updates — pick an approach (the agent records it via `goal_select_approach`).

**Too many goals with no progress**
Goals without active approaches accumulate in the store. Tell the agent to pause or abandon stale ones (`goal_update`), or edit `goals.json`, to keep the weekly status meaningful.

**Goal decomposition is generic / not useful**
The quality of decomposition depends on how specific the goal statement is. "Improve things" is hard to decompose. "Get weekly OKR scoring rates above 80% by end of Q3" gives the agent something concrete to work with.

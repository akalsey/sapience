# OpenClaw Goals

Some things worth doing aren't tasks. They're directions — fuzzy, long-running, and valuable even when the path isn't clear. "Our teams aren't scoring OKRs regularly" is a goal, not a ticket.

This plugin accepts those kinds of objectives, decomposes them into candidate approaches, tracks incremental progress, and delivers a weekly status update. You stay oriented without managing the detail.

This plugin is part of the Sapience Suite that gives your OpenClaw agent genuine agency — not just the ability to execute tasks, but the judgment to know when to act, when to ask, when to propose, and when to say "I'm not sure how you want me to handle this."

This plugin can be used without Sapience if all you want to do is track multi-step tasks.

---

## Setup

### Install

```bash
openclaw plugins install npm:@akalsey/sapience-goals
```

### Configuration

```json
{
  "plugins": {
    "sapience-goals": {
      "weeklyCheckInDay": "monday",
      "weeklyCheckInTime": "09:00",
      "activeHours": {
        "start": "08:00",
        "end": "20:00",
        "timezone": "America/Los_Angeles"
      },
      "inboxPath": "goals/inbox.md"
    }
  }
}
```

All settings are optional — defaults above are used if omitted. Relative paths resolve under the agent workspace dir (`<workspace>/`); absolute and `~/` paths are honored. Invalid `activeHours` values fall back to defaults and emit a `config_invalid` event. Full key reference: [docs/configuration.md](../docs/configuration.md).

### Output files

| File | Purpose |
|------|---------|
| `<workspace>/goals/goals.json` | All goals with status, approaches, progress, blockers |
| `<workspace>/goals/inbox.md` | Where you (or scripts) write new goals |
| `<workspace>/goals/inbox-position.json` | Byte offset tracking — don't edit this |

---

## Submitting a goal

Just tell the agent in conversation:

> "I want to improve our OKR scoring rate"
> "Figure out why PostHog costs keep spiking"
> "Help me build a habit of writing weekly team updates"

The agent recognizes long-running objectives and calls `goal_submit` automatically. The decomposition prompt is delivered immediately — as a next-turn injection into your main session, so it appears on your next turn.

### Via the inbox file (scripting/external use)

You can also append goals directly to the inbox file for use from scripts or other tools:

```bash
echo "Our teams aren't scoring OKRs regularly — improve that" >> <workspace>/goals/inbox.md
```

The next `check_goals` cron run (within 15 minutes, during active hours) picks it up. The plugin won't error if the file is missing — create it when you need it.

---

## Decomposition

When a new goal is detected, the agent delivers a `[GOALS: DECOMPOSE]` prompt to your active session:

> "I noticed this goal: 'Our teams aren't scoring OKRs regularly.' Here are 3 approaches I could take…"

It presents 2–4 concrete approaches, explains what each would accomplish and what it would need from you, and asks you to pick one (or none).

When you pick, the agent calls `goal_select_approach` (the decomposition prompt instructs it to) — that records your pick as the `active_approach` and moves the goal to `active`. Goals without a selected approach stay in `decomposing` status and don't receive weekly updates until you pick one.

---

## Goal lifecycle tools

The plugin registers five tools the agent calls in conversation — you never invoke these directly, just talk:

| Tool | Does |
|------|------|
| `goal_submit(description)` | Creates a goal in `decomposing` status and delivers the decomposition prompt immediately |
| `goal_select_approach(id, approach)` | Records the approach you picked and marks the goal `active` |
| `goal_update(id, status)` | Status transitions: `active`, `paused`, `completed`, `abandoned` |
| `goal_progress(id, summary, what_changed?)` | Records a progress note when meaningful work toward the goal happens |
| `goal_blocker(id, description, waiting_on?)` | Records something blocking progress |

So "mark the OKR goal complete" or "note that the PostHog goal is blocked on billing access" work as plain conversation. `goals.json` is still plain JSON if you prefer to edit directly.

---

## Weekly status

Every Monday at 9am (or your configured day/time), goals with `status: "active"` get a `[GOALS: WEEKLY STATUS]` prompt delivered to your main session's next turn:

> "Weekly status for 'Improve OKR scoring rates':
> - What happened this week: …
> - What's blocked: …
> - What I plan next week: …"

Each goal gets its own delivery. If nothing happened and nothing is blocked, the agent says so briefly and doesn't pad.

The next delivery date is stored per-goal in `goals.json` and rolls forward automatically after each successful delivery. If an injection fails, a `delivery_failed` event is recorded and the status is retried on the next run rather than silently skipping a week.

---

## Troubleshooting

**Goal submitted in conversation but no decomposition prompt**
Delivery is a next-turn injection — it appears the next time you take a turn in your main session. If it still doesn't, look for `delivery_failed` events in `<workspace>/sapience/events.jsonl`.

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

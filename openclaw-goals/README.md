# OpenClaw Goals

Some things worth doing aren't tasks. They're directions — fuzzy, long-running, and valuable even when the path isn't clear. "Our teams aren't scoring OKRs regularly" is a goal, not a ticket.

This plugin accepts those kinds of objectives, decomposes them into candidate approaches, tracks incremental progress, and delivers a weekly status update. You stay oriented without managing the detail.

This plugin is part of the Sapience Suite that gives your OpenClaw agent genuine agency — not just the ability to execute tasks, but the judgment to know when to act, when to ask, when to propose, and when to say "I'm not sure how you want me to handle this."

This plugin can be used without Sapience if all you want to do is track multi-step tasks.

---

## Setup

### Install

```bash
openclaw plugins install local:/path/to/openclaw-goals
```

### Configuration

```json
{
  "plugins": {
    "goals": {
      "weeklyCheckInDay": "monday",
      "weeklyCheckInTime": "09:00",
      "activeHours": {
        "start": "08:00",
        "end": "20:00",
        "timezone": "America/Los_Angeles"
      },
      "inboxPath": "~/.openclaw/sapience/goals-inbox.md"
    }
  }
}
```

All settings are optional — defaults above are used if omitted.

### Create the inbox file

```bash
touch ~/.openclaw/sapience/goals-inbox.md
```

The plugin won't error if the file is missing, but you need it to submit goals.

### Output files

| File | Purpose |
|------|---------|
| `~/.openclaw/sapience/goals.json` | All goals with status, approaches, progress, blockers |
| `~/.openclaw/sapience/goals-inbox.md` | Where you write new goals |
| `~/.openclaw/sapience/goals-inbox-position.json` | Byte offset tracking — don't edit this |

---

## Submitting a goal

Append any plain-text goal statement to the inbox file:

```bash
echo "Our teams aren't scoring OKRs regularly — improve that" >> ~/.openclaw/sapience/goals-inbox.md
echo "Get better signal on what's actually blocking our engineers" >> ~/.openclaw/sapience/goals-inbox.md
```

Lines starting with `#` are ignored (use them for comments). Blank lines are ignored.

The next cron pass (within 15 minutes) reads new lines and triggers decomposition for each one.

---

## Decomposition

When a new goal is detected, the agent delivers a `[GOALS: DECOMPOSE]` prompt to your active session:

> "I noticed this goal: 'Our teams aren't scoring OKRs regularly.' Here are 3 approaches I could take…"

It presents 2–4 concrete approaches, explains what each would accomplish and what it would need from you, and asks you to pick one (or none).

Your selection is recorded as the `active_approach`. Goals without a selected approach stay in `decomposing` status and don't receive weekly updates until you pick one.

---

## Tracking progress

Progress is tracked through the weekly status loop — the agent notes what it did toward the goal and what it plans next. You can also add progress notes manually:

```bash
# Not yet a built-in command — edit goals.json directly for now
```

To mark a goal complete or pause it, update the `status` field in `~/.openclaw/sapience/goals.json`:

```json
{ "status": "completed" }
```

Valid statuses: `decomposing` | `active` | `paused` | `completed` | `abandoned`

---

## Weekly status

Every Monday at 9am (or your configured day/time), active goals get a `[GOALS: WEEKLY STATUS]` prompt delivered to your session:

> "Weekly status for 'Improve OKR scoring rates':
> - What happened this week: …
> - What's blocked: …
> - What I plan next week: …"

Each goal gets its own delivery. If nothing happened and nothing is blocked, the agent says so briefly and doesn't pad.

The next delivery date is stored per-goal in `goals.json` and rolls forward automatically after each delivery.

---

## Troubleshooting

**Goal submitted but no decomposition prompt**
The cron fires every 15 minutes. Wait for the next pass, or trigger manually:
```bash
openclaw cron run goals-check-pass
```
Also confirm the inbox path matches your config and that the file is readable.

**Same goals showing up again after re-install**
The byte-position tracker (`goals-inbox-position.json`) tracks what's been read. If it's missing, the inbox is read from the beginning. Delete old content from the inbox file, or manually set the position to the file's current byte length.

**Weekly status not delivering**
Check `goals.json` — the goal must have `status: "active"` and `next_status_delivery` must be a past date. If `active_approach` is empty, the goal is still in `decomposing` status and won't get weekly updates.

**Too many goals with no progress**
Goals without active approaches accumulate in the store. Periodically review `goals.json` and mark stale goals as `paused` or `abandoned` to keep the weekly status meaningful.

**Goal decomposition is generic / not useful**
The quality of decomposition depends on how specific the goal statement is. "Improve things" is hard to decompose. "Get weekly OKR scoring rates above 80% by end of Q3" gives the agent something concrete to work with.

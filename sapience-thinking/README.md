# OpenClaw Thinking

Your agent notices things. While it works, it watches for anomalies, patterns, and opportunities that don't fit neatly into scheduled tasks — the kind of "I noticed this while doing something else" observations that a thoughtful colleague would flag. Every 15 minutes during working hours, it runs a brief thinking pass over recent activity, produces a structured list of observations and proposed actions, and surfaces anything worth your attention.

The output is a reviewable log file, not autonomous action. You see what it noticed, you decide what to do with it.

This plugin is part of the Sapience Suite that gives your OpenClaw agent genuine agency — not just the ability to execute tasks, but the judgment to know when to act, when to ask, when to propose, and when to say "I'm not sure how you want me to handle this."

This plugin can be used without Sapience if all you want to do is surface observations to the human.

## Setup

### Install

```bash
openclaw plugins install npm:@akalsey/sapience-thinking
```

### Configuration

Add to your OpenClaw config:

```json
{
  "plugins": {
    "sapience-thinking": {
      "schedule": "*/15 * * * *",
      "activeHours": {
        "start": "08:00",
        "end": "20:00",
        "timezone": "America/Los_Angeles"
      },
      "output": {
        "logPath": "~/.openclaw/proactive-thinking/thinking-log.md"
      }
    }
  }
}
```

All settings are optional — the defaults above are used if omitted.

### Output files

| File | Purpose |
|------|---------|
| `~/.openclaw/proactive-thinking/thinking-log.md` | Human-readable log of every pass |
| `~/.openclaw/proactive-thinking/outcomes.json` | Tracks which proposals you acted on |
| `~/.openclaw/proactive-thinking/proposals.jsonl` | Structured sidecar read by `sapience` |

---

## What a pass looks like

Each entry in `thinking-log.md` has:

- **Observations** — things noticed with supporting evidence and priority (1–5)
- **Proposed actions** — concrete things to do, with estimated effort
- **Proposed audits** — domains worth reviewing
- **Open questions** — things blocking analysis
- **Summary** — one-paragraph overview

A pass that found nothing useful logs `nothing_to_report: true`. Over time, this data shows when thinking passes are productive.

---

## Active hours

Passes only fire within `activeHours`. Outside that window, the cron fires but silently skips — no log entry. Set the window to match your working hours.

---

## Troubleshooting

**Nothing in the log after install**
The plugin fires on cron schedule, not immediately. Wait for the next 15-minute boundary, or manually trigger:
```bash
openclaw cron run sapience-thinking
```

**Passes are running but log is empty**
Check that `logPath` is writable and that the path (including `~`) is resolving correctly. Try an absolute path first.

**Too many proposals, too much noise**
The signal-to-noise data in `outcomes.json` feeds back into future prompts after 14 days. Mark proposals as acted-on or dismissed to train the signal:
```bash
openclaw thinking resolve <proposal-id> acted_on
openclaw thinking resolve <proposal-id> dismissed
```

**`nothing_to_report` on every pass**
This usually means the context bundle is too thin — no recent session activity to analyze. The plugin needs active use of OpenClaw to have something to think about.

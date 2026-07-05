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
      "activeHours": {
        "start": "08:00",
        "end": "20:00",
        "timezone": "America/Los_Angeles"
      },
      "output": {
        "logPath": "proactive-thinking/log.md"
      }
    }
  }
}
```

All settings are optional — the defaults above are used if omitted. The 15-minute cadence comes from the openclaw cron job (see [docs/cron-setup.md](../docs/cron-setup.md)), not from plugin config. Full key reference: [docs/configuration.md](../docs/configuration.md).

### Output files

Relative paths resolve under the agent workspace dir (`<workspace>/`), not `~/.openclaw`. Absolute and `~/` overrides in config are honored.

| File | Purpose |
|------|---------|
| `<workspace>/proactive-thinking/log.md` | Human-readable log of every pass |
| `<workspace>/proactive-thinking/outcomes.json` | Tracks which proposals you acted on |
| `<workspace>/proactive-thinking/proposals.jsonl` | Structured sidecar read by `sapience` |

`log.md` and `proposals.jsonl` rotate at 5 MB: the newest 500 lines stay in place, the previous contents move to a single `<file>.old`.

---

## What a pass looks like

Each entry in `log.md` has:

- **Observations** — things noticed with supporting evidence and priority (1–5)
- **Proposed actions** — concrete things to do, with estimated effort
- **Proposed audits** — domains worth reviewing
- **Open questions** — things blocking analysis
- **Summary** — one-paragraph overview

A pass that found nothing useful logs `nothing_to_report: true`. Over time, this data shows when thinking passes are productive.

---

## Active hours

Passes only fire within `activeHours`. Outside that window, the cron fires but skips; a single `pass_skipped` (`outside_hours`) event is logged on the transition out of hours, not every 15 minutes all night. Overnight windows (start later than end) are supported.

Invalid values (`"8am"`, a bad timezone) don't disable the plugin: it falls back to the default hours and emits a `config_invalid` event.

## Delivery

When `sapience` is installed and active, thinking passes are routed by its autonomy layer — this plugin defers direct delivery. Standalone (or if the router hasn't run in 2 hours), high-priority proposals (`priorityThreshold`, default 4+) are injected into your main session's next turn, capped at `maxProposalsPerHeartbeat` (default 3) per pass. Injection failures record a `delivery_failed` event.

---

## Troubleshooting

**Nothing in the log after install**
The plugin fires on cron schedule, not immediately. Wait for the next 15-minute boundary, or manually trigger:
```bash
openclaw cron run sapience-thinking
```

**Passes are running but log is empty**
Run `openclaw sapience doctor`. The most common cause is the cron session not seeing the plugin tools (missing `--tools` grant) — the run reports ok but nothing is written. See [docs/troubleshooting.md](../docs/troubleshooting.md). Otherwise check that `logPath` is writable and resolving where you expect (the doctor's PATHS section shows the resolved paths).

**Too many proposals, too much noise**
After the 14-day bootstrap period (`learning.bootstrapDays`), the signal-to-noise data in `outcomes.json` feeds back into future prompts. Outcome resolution (marking proposals acted-on/dismissed) is tracked internally but not currently exposed as a command — set `delivery.priorityThreshold` higher to cut noise in the meantime.

**`nothing_to_report` on every pass**
This usually means the context bundle is too thin — no recent session activity to analyze. The plugin needs active use of OpenClaw to have something to think about.

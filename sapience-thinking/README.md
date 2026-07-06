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

## What a pass reads

The context bundle for each pass is built from what's actually on disk, resolved through the runtime:

- **Session transcripts** — recent activity from the agent's real sessions dir, ordered by file mtime (newest first) within the `lookbackHours` window
- **Memory** — the memory-wiki vault first, then the legacy per-agent memory dir; newest `.md` files first
- **Active goals** — in-flight goals from `goals/goals.json`, so passes weigh proposals by whether they advance one
- **Open hypotheses** — unsettled cases from sapience's hypothesis ledger, for opportunistic re-testing when adjacent data is in hand
- **Analytical playbooks** — built-in analyst moves (decompose on delta, outlier check, denominator check, seasonality check, case-to-cohort) plus any you've taught via method feedback, loaded from `<workspace>/sapience/playbooks.json`

The resolved sessions and memory dirs are recorded in the plugin's status artifact, so `openclaw sapience doctor` shows exactly which directories a pass reads.

## What a pass looks like

Each entry in `log.md` has:

- **Observations** — things noticed with supporting evidence, priority (1–5), and an **evidence grade**: `hunch` (unverified pattern-suspicion), `quick_check` (verified against the data at hand), or `replicated` (has held repeatedly). Grades gate how much initiative routing allows downstream
- **Proposed actions** — concrete things to do, with estimated effort and a `reversible` flag; only actions explicitly marked reversible ever execute autonomously
- **Proposed audits** — domains worth reviewing
- **Open questions** — things blocking analysis
- **Summary** — one-paragraph overview

A pass that found nothing useful logs `nothing_to_report: true`. Over time, this data shows when thinking passes are productive.

Before anything is recorded, proposals are deduplicated against the last 14 days of outcome history — a proposal you dismissed last week doesn't resurface reworded. Drops are logged as `proposals_deduped` events.

---

## Closing the loop: `record_outcome`

Every delivered proposal carries an instruction to record your reaction via the `record_outcome` tool: `acted_on` or `accepted` (positive), `rejected`, or `acknowledged` (seen but deferred). Outcomes feed the signal-to-noise report, and — except for `acknowledged` — move calibration confidence for the proposal's domain by ±0.1.

When you accept an **audit** proposal, it becomes recurring coverage: the plugin registers a `sapience-audit-<slug>` cron job that runs the audit weekly (Mondays 09:00) and reports findings — or a clean bill — back to you.

---

## Post-task noticing

Beyond scheduled passes, the plugin has peripheral vision over live sessions. When a substantial turn completes (at least `noticing.minTurnChars` characters, at most once per `noticing.cooldownMinutes` per session), a cheap side-pass asks one question: what crossed the agent's path that *wasn't* the point of the task? Duplicate accounts spotted while pulling a report, a surprising number, a dead link.

Findings become hunch-graded observations in `proposals.jsonl` with provenance (`noticed` events record the source session), so they flow through the normal routing, investigation, and evidence machinery. The suite's own `sapience-*` machine sessions are never watched, and an empty result is the normal one. Disable with `noticing.enabled: false`.

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
React to what's delivered — the agent records your reactions via `record_outcome`, and after the 14-day bootstrap period (`learning.bootstrapDays`) the signal-to-noise data in `outcomes.json` feeds back into future prompts. Repeats of recently dismissed proposals are already suppressed by the 14-day dedup. To cut noise further, set `delivery.priorityThreshold` higher (standalone mode) or raise `noticing.minTurnChars` / disable `noticing`.

**`nothing_to_report` on every pass**
This usually means the context bundle is too thin — no recent session activity to analyze. The plugin needs active use of OpenClaw to have something to think about. Run `openclaw sapience doctor` and check the resolved `contextSessionsDir`/`contextMemoryDirs` paths point where your sessions actually live; `openclaw sapience doctor --probe` runs one real pass end-to-end.

# Observability: Monitoring What Sapience Is Doing

Sapience writes two files you can read at any time to understand what it has done, what it's currently doing, and whether it's having an effect.

---

## The dashboard

**File:** `~/.openclaw/sapience/dashboard.md`

This is the primary view. It is regenerated at the end of every sapience routing pass — at most 15 minutes stale. Open it in any markdown viewer.

```
cat ~/.openclaw/sapience/dashboard.md
```

The dashboard has three sections:

### Autonomy progression

A table of every domain/action_class pair sapience has observed, showing:

| Column | What it means |
|--------|---------------|
| Tier | Current autonomy level: `act` (autonomous), `propose` (suggests for approval), `ask` (asks before acting), `explore` (information only) |
| Confidence | 0.0–1.0 score driving tier placement |
| 7d trend | Sparkline of confidence changes over the last 7 days, plus delta (e.g. `▁▃▅▇█ ↑ +0.18`) |
| Confirmed | Times you've confirmed sapience was right |
| Corrected | Times you've corrected sapience |

Below the table: tier promotions in the last 30 days, and count of autonomous actions taken (7d / 30d).

New deployments show `(no history yet)` in the trend column until calibration events accumulate.

### Heartbeat

Shows whether each plugin is actually running:

| Column | What it means |
|--------|---------------|
| Runs (24h) | How many times the plugin completed work in the last 24 hours |
| Expected | Approximate expected runs based on active hours and 15-min cadence |
| Skips (24h) | Skipped runs with reason (e.g. `10 outside_hours`) |
| Last activity | Timestamp of the most recent event from this plugin |

If Runs is zero and Expected is non-zero, the cron may not be running — check `openclaw cron list`.

### Recent activity

The last 15 notable events (skips are filtered out here; they're aggregated in Heartbeat). Examples:

```
- 2026-06-09 14:15 thinking pass abc123: 2 obs, 1 actions, 0 audits, 0 questions
- 2026-06-09 11:02 correction captured (github, llm)
- 2026-06-09 09:44 routed 3 item(s) from 1 pass(es)
- 2026-06-09 09:44 calibration github/action: propose→act conf 0.82
```

---

## The event log

**File:** `~/.openclaw/sapience/events.jsonl`

Every event from every plugin is appended here as a newline-delimited JSON record. The dashboard is derived from this file. Read it directly for raw history or to debug unexpected behavior.

```
tail -50 ~/.openclaw/sapience/events.jsonl | jq .
```

Filter by plugin:

```
grep '"plugin":"feedback"' ~/.openclaw/sapience/events.jsonl | tail -20 | jq .
```

Filter by event type:

```
grep '"type":"calibration_change"' ~/.openclaw/sapience/events.jsonl | jq '{ts,domain:(.action_class),old:.old_tier,new:.new_tier}'
```

### Event types

**sapience-thinking:**
- `pass_completed` — a thinking pass finished; fields: `pass_id`, `observations`, `actions`, `audits`, `questions`, `nothing_to_report`
- `pass_skipped` — pass did not run; field: `reason` (`outside_hours` or `already_running`)

**sapience:**
- `routing_completed` — routing pass processed proposals; fields: `passes`, `items`, `by_tier`
- `routing_skipped` — routing did nothing; field: `reason` (`outside_hours` or `no_new_passes`)
- `calibration_change` — a confidence or tier changed; fields: `domain`, `action_class`, `old_confidence`, `new_confidence`, `old_tier`, `new_tier`, `source`
- `action_logged` — an act-tier action was taken autonomously; fields: `domain`, `action_class`, `confidence`
- `digest_delivered` — weekly digest was queued

**sapience-feedback:**
- `signal_detected` — feedback signal captured from conversation; fields: `signal_type`, `domain`, `action_class`, `source`
- `signal_orphaned` — a signal matched no calibration entry (no domain/action_class in the profile yet)

**sapience-goals:**
- `goal_created` — a goal was created; field: `goal_id`
- `status_delivered` — weekly status delivered for a goal; field: `goal_id`
- `check_skipped` — goals check did nothing; field: `reason`

---

## Log rotation

When `events.jsonl` exceeds 5 MB, it is automatically renamed to `events-archive-YYYY-MM-DD-HH-MM-SS.jsonl` in the same directory before the dashboard is regenerated. Archives are never deleted. The active `events.jsonl` restarts empty; the dashboard's 7-day trends self-heal within a week as new calibration events accumulate.

---

## Diagnosing common situations

**"I don't see the dashboard file yet"**

The dashboard is generated at the end of each routing pass. If the sapience cron hasn't run yet, the file won't exist. Check that the cron is registered: `openclaw cron list`. The installer (`install.sh`) sets this up automatically.

**"Heartbeat shows 0 runs, expected ~48"**

The cron likely isn't running or the plugin isn't activated. Verify with `openclaw cron list` and `openclaw plugins list`.

**"Crons show `error`, lastError mentions `agents.defaults.models` allowlist"**

The cron payload pins a `model` that the gateway doesn't permit, so cron *preflight* rejects every run before it starts. Tell-tale signs: `lastRunStatus: error`, a `lastDurationMs` in the tens of milliseconds, and a `lastError` like:

```text
cron payload.model '<model>' rejected by agents.defaults.models allowlist: ...
```

This happens when a cron was created with `--model <model>` for a model that isn't in `agents.defaults.models`. The fix is to **not pin a model on the cron at all** — let it inherit the agent's default model, which is allowlisted by definition. The installer no longer pins a model (`install.sh` omits `--model`). To repair an existing job, delete and re-add it without `--model`, or patch the job to clear its `payload.model`. Inspect the current allowlist with `openclaw config get agents.defaults.models`.

**"Crons show ok but events.jsonl never appears"**

The cron ran but its tool calls didn't land — check the run actually invoked the plugin's tool (e.g. `record_thinking_output`). If the model replied without calling tools, confirm the cron's agent uses a model with reliable tool-calling. Do **not** work around this by pinning an arbitrary model with `--model`: a model outside `agents.defaults.models` makes the cron fail preflight entirely (see the entry above).

**"All 7d trends say '(no history yet)'"**

Normal on a new deployment. Trends appear after the first calibration change event. Correct or confirm a suggestion to trigger one immediately.

**"I see signal_orphaned events"**

A feedback signal matched no entry in `calibration.json`. This happens when you give feedback on a domain sapience hasn't learned about yet. The signal is still logged; once sapience encounters activity in that domain, a calibration entry will be created and future feedback will stick.

**"I want to see what sapience decided to do autonomously"**

```
grep '"type":"action_logged"' ~/.openclaw/sapience/events.jsonl | jq '{ts,domain,action_class,confidence}'
```

Or read `~/.openclaw/sapience/action-log.md` for the full prose log of autonomous actions.

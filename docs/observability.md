# Observability: Monitoring What Sapience Is Doing

Sapience writes two files you can read at any time to understand what it has done, what it's currently doing, and whether it's having an effect.

Paths below use `<workspace>/` for the agent workspace directory — see ["Where files live"](../README.md#where-files-live). For a health check rather than a history, run `openclaw sapience doctor` ([docs/troubleshooting.md](troubleshooting.md)).

---

## The dashboard

**File:** `<workspace>/sapience/dashboard.md`

This is the primary view. It is regenerated at the end of every sapience routing pass — at most 15 minutes stale. Open it in any markdown viewer.

```
cat <workspace>/sapience/dashboard.md
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

Below the table: tier changes in the last 30 days, and count of autonomous actions taken (7d / 30d).

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

**File:** `<workspace>/sapience/events.jsonl`

Every event from every plugin is appended here as a newline-delimited JSON record. The dashboard is derived from this file. Read it directly for raw history or to debug unexpected behavior.

```
tail -50 <workspace>/sapience/events.jsonl | jq .
```

Filter by plugin:

```
grep '"plugin":"feedback"' <workspace>/sapience/events.jsonl | tail -20 | jq .
```

Filter by event type:

```
grep '"type":"calibration_change"' <workspace>/sapience/events.jsonl | jq '{ts,domain:(.action_class),old:.old_tier,new:.new_tier}'
```

### Event types

Every event has `ts` (ISO-8601), `plugin` (`thinking` | `sapience` | `feedback` | `goals`), and `type`.

**sapience-thinking** (`plugin: "thinking"`):
- `pass_completed` — a thinking pass finished; fields: `pass_id`, `observations`, `actions`, `audits`, `questions`, `nothing_to_report`
- `pass_skipped` — pass did not run; field: `reason` (`outside_hours` or `already_running`). `outside_hours` is logged once on the transition out of hours, not every 15 minutes
- `proposals_deduped` — near-duplicates of proposals from the last 14 days were dropped before routing; fields: `pass_id`, `dropped`
- `proposals_coerced` — the pass's output was recovered from a malformed shape; items that couldn't be salvaged are counted; fields: `pass_id`, `dropped_items`
- `outcome_recorded` — the agent recorded your reaction to a delivered proposal via `record_outcome`; fields: `proposal_id`, `outcome` (`acted_on`/`accepted`/`rejected`/`acknowledged`), `domain`, `action_class`
- `audit_scheduled` / `audit_schedule_failed` — an accepted audit proposal was (or couldn't be) registered as a recurring `sapience-audit-<slug>` cron job; fields: `cron`, plus `reason` on failure
- `stale_deliveries_dropped` — answering a proposal retired queued deliveries that spoke to the same thing, so they aren't surfaced after you've already settled them; fields: `proposal_id` (the one you answered), `dropped`, `dropped_ids`
- `noticed` — post-task noticing found incidental observations in a live session; fields: `session`, `observations`, `watcher`, `pid`. One turn should produce one event. Several sharing a `pid` but carrying different `watcher` values mean transcript listeners are accumulating in that process — the leak fixed in 0.5.7, so seeing it again is a regression. Differing `pid`s mean more than one gateway process is writing these files, which this plugin cannot fix on its own.
- `delivery_failed` — standalone-mode injection into the main session failed; field: `reason`
- `config_invalid` — invalid `activeHours` config; running on defaults; fields: `field`, `errors`, `using`

**sapience** (`plugin: "sapience"`):
- `routing_completed` — routing pass processed proposals; fields: `passes`, `items`, `by_tier`
- `routing_skipped` — routing did nothing; field: `reason` (`outside_hours` [logged once per transition], `no_new_passes`, or `already_running`)
- `calibration_change` — a calibration entry was created or changed; fields: `domain`, `action_class`, `old_confidence`, `new_confidence`, `old_tier`, `new_tier`, `source` (`new_entry` when routing first sees a domain)
- `action_logged` — an act-tier action was taken autonomously; fields: `domain`, `action_class`, `confidence`
- `act_executed` / `act_failed` — an act-tier item finished (or failed) executing in its isolated subagent session; fields: `proposal_id`, `domain`, `report`
- `investigation_completed` — a hunch got its bounded read-only investigation; fields: `proposal_id`, `domain`, `verdict` (`supported`/`refuted`/`inconclusive`)
- `hypotheses_resolved` — the agent settled tracked hypotheses via `hypothesis_resolve`, usually after a user correction or a first-hand check; fields: `match`, `verdict`, `count` (0 means nothing matched)
- `push_requested` — a high-priority item requested a channel push (heartbeat to the last active channel); fields: `tier`, `domain`, `priority`, `requested`
- `watch_added` / `watch_removed` — a metric watch was created or removed; field: `watch`
- `watch_checked` — a due watch was checked; fields: `watch`, `value`, `notable`
- `watch_check_failed` — the watch's value couldn't be fetched (cadence still advances); field: `watch`
- `digest_delivered` — weekly digest was queued for the next main-session turn
- `item_delivered` — positive receipt: a tier prompt was accepted for the next turn; fields: `proposal_id`, `tier`, `domain`, `priority`
- `item_queued` — the item exceeded `delivery.maxPerCycle` and went to the pending queue for the `sapience-delivery` cron; fields: `proposal_id`, `tier`, `priority`, `queued`
- `item_suppressed` — the item's text matched something delivered within `delivery.dedupeWindowHours`; fields: `proposal_id`, `domain`, `reason` (`recently_delivered`)
- `pending_deliveries_drained` — the delivery cron picked up queued items to compose into one message; field: `count`
- `skill_proposal_created` / `skill_proposal_evidence` — a repeated multi-step task was logged as a skill spec, or matched an existing one and added evidence; fields: `proposal_id`, `evidence_count`
- `skill_proposal_updated` — the human's decision was recorded; fields: `proposal_id`, `status` (`proposed`/`building`/`installed`/`declined`)
- `skill_proposal_duplicate_blocked` — a proposal was refused because an installed skill already covers it; nothing was written to the ledger. Fields: `proposed_name`, `existing_skill`, `reason` (`same_name`, or `unjustified_overlap` when the caller hadn't said what the existing skill can't do). A run of these on one name means the agent keeps rediscovering a skill it isn't using
- `delivery_failed` — a tier prompt, the digest, or a watch alert could not be injected; fields: `reason`, `queued` (whether it fell back to the pending queue), plus `tier`/`domain` and `items` (how many items the declined note carried), `what: "digest"`, or `what: "watch"`
- `config_invalid` — invalid `activeHours` config; running on defaults

**sapience-feedback** (`plugin: "feedback"`):
- `signal_detected` — feedback signal captured; fields: `signal_type`, `domain`, `action_class`, `source` (`llm`, `regex`, or `manual`)
- `calibration_change` — the signal was applied to the profile; same fields as sapience's event, with `source` `feedback` (existing entry updated) or `feedback_new_entry` (feedback on an unknown domain seeded a new entry — orphaned signals are no longer dropped). The `plugin` field distinguishes these from sapience's own calibration events
- `playbook_added` / `playbook_duplicate` — a `method` signal appended a new analytical playbook (or matched an existing one); fields: `domain`, `source`
- `playbook_rejected` — the text wasn't a single analytical move and was not stored (a one-time directive kept as a permanent playbook gets re-proposed every pass); fields: `reason` (`too_long`/`empty`), `domain`, `source`
- `memory_write_failed` — the meta-pointer write via `api.memory.add` failed; fields: `domain`, `reason`

**sapience-goals** (`plugin: "goals"`):
- `goal_created` — a goal was created (via `goal_submit` or the inbox); field: `goal_id`
- `goal_activated` — an approach was selected (`goal_select_approach`); field: `goal_id`
- `goal_status_changed` — status transition via `goal_update`; fields: `goal_id`, `status`
- `goal_progress` — progress note recorded; field: `goal_id`
- `goal_metric_set` — a measurable key result was attached via `goal_set_metric`; fields: `goal_id`, `metric`
- `goal_planned` — `goal_plan` saved standing instructions and installed them as a temporary skill; fields: `goal_id`, `todos` (count seeded)
- `goal_todo` — a todo was added or completed; fields: `goal_id`, `action` (`add`/`done`), `open` (remaining open todos)
- `goal_blocked` — blocker recorded; field: `goal_id`
- `status_delivered` — weekly status queued for a goal; field: `goal_id`
- `delivery_failed` — a decomposition or weekly-status injection failed; fields: `what` (`decomposition` or `weekly_status`), `goal_id`, `reason`. Failed weekly statuses are retried next run
- `check_skipped` — goals check did nothing; field: `reason` (`outside_hours` [once per transition] or `nothing_due`)
- `config_invalid` — invalid `activeHours` config; running on defaults

---

## Log rotation

When `events.jsonl` exceeds 5 MB, it is renamed to `events-archive-YYYY-MM-DD-HH-MM-SS.jsonl` in the same directory before the dashboard is regenerated, and only the **newest two archives are kept** — older ones are pruned. The active `events.jsonl` restarts empty; the dashboard's 7-day trends self-heal within a week as new calibration events accumulate.

The prose/sidecar logs — `proactive-thinking/log.md`, `proactive-thinking/proposals.jsonl`, `sapience/action-log.md`, `sapience/feedback.md` — rotate differently: past 5 MB, the newest 500 lines stay in place and the previous contents move to a single `<file>.old` (replacing the prior `.old`, so disk stays bounded).

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

The cron ran but its tool calls didn't land. The most common cause: the isolated cron session can't see the plugin tools because the job has no `payload.toolsAllow` grant — run `openclaw sapience doctor`, which detects exactly this, and see [docs/troubleshooting.md](troubleshooting.md). If the tools are granted, confirm the cron's agent uses a model with reliable tool-calling. Do **not** work around this by pinning an arbitrary model with `--model`: a model outside `agents.defaults.models` makes the cron fail preflight entirely (see the entry above).

**"All 7d trends say '(no history yet)'"**

Normal on a new deployment. Trends appear after the first calibration change event. Correct or confirm a suggestion to trigger one immediately.

**"I gave feedback on a domain sapience doesn't know yet"**

It's not lost. The feedback plugin seeds a new calibration entry (`propose` tier, confidence 0) and applies the signal, emitting `calibration_change` with `source: "feedback_new_entry"`.

**"I see delivery_failed events"**

The plugin produced output but couldn't inject it into the target session (gateway declined, or the injection API was unavailable). Check the `reason` field — and `queued`: when true, the item went to `<workspace>/sapience/pending-deliveries.json` and the `sapience-delivery` cron sends it through your channel within 15 minutes, so a dead injection path degrades to latency rather than silence. Weekly goal statuses also retry on the next run.

**"I want to see what sapience decided to do autonomously"**

```
grep '"type":"action_logged"' <workspace>/sapience/events.jsonl | jq '{ts,domain,action_class,confidence}'
```

Or read `<workspace>/sapience/action-log.md` for the full prose log of autonomous actions.

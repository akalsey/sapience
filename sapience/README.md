# Sapience Suite for OpenClaw

The Sapience Suite transforms OpenClaw from a reactive assistant into a proactive agent with genuine autonomy. It learns when to act, when to propose, when to ask, and when to explore — calibrated to your actual preferences, not a static policy you had to configure upfront.

The suite has four plugins that each work independently and compose into a whole:

| Plugin | Does |
|--------|------|
| `sapience-thinking` | Periodic thinking passes; generates observations and proposals |
| `sapience` *(this plugin)* | Routes proposals through autonomy tiers; calibrates to your preferences; delivers weekly digest |
| `sapience-feedback` | Captures corrections and confirmations from chat; recalibrates autonomy profile |
| `sapience-goals` | Accepts fuzzy long-running goals; decomposes them; tracks progress; weekly status |

## How it works

`sapience-thinking` runs a thinking pass every 15 minutes and writes proposals to `proposals.jsonl`. `sapience` reads that sidecar, routes each proposal through an autonomy decision function, and delivers it to your main session at the right level:

- **Act** — high-confidence, reversible, low-blast-radius → done immediately, brief notification
- **Propose** — worth doing, needs your approval → surfaces it for a yes/no
- **Ask** — agent can do it but needs one piece of information → asks exactly what's needed
- **Explore** — the problem is real but the right path is unclear → presents 2–3 options with tradeoffs
- **Learning** — new domain or low confidence → calibration question before acting

The routing decision uses a calibration profile: per-domain, per-action-class entries with a confidence score. Until a domain is calibrated, everything goes through **Learning** mode and will ask you to confirm its choices before acting.

## Setup

### Prerequisites

Install `sapience-thinking` first. Sapience reads its output.

### Install order

```bash
openclaw plugins install npm:@akalsey/sapience-thinking
openclaw plugins install npm:@akalsey/sapience
openclaw plugins install npm:@akalsey/sapience-feedback   # optional
openclaw plugins install npm:@akalsey/sapience-goals       # optional
```

### Configuration (sapience)

```json
{
  "plugins": {
    "sapience": {
      "autonomy": {
        "defaultTier": "propose",
        "domainFloors": {
          "github": "propose",
          "salesforce": "ask"
        }
      },
      "learning": {
        "enabled": true,
        "confidenceDropThreshold": 0.4
      },
      "digest": {
        "enabled": true,
        "day": "friday",
        "time": "17:00"
      }
    }
  }
}
```

**`defaultTier`** — What tier to use for uncalibrated actions when learning mode is off. Default: `"propose"`.

**`domainFloors`** — Minimum tier for a domain. If calibration says `act` for a domain with floor `propose`, it routes as `propose`. Use this for domains where you never want autonomous action regardless of confidence.

**`confidenceDropThreshold`** — Below this confidence, Learning mode fires instead of the calibrated tier. Default: `0.4`.

**`digest`** — Weekly summary of what was acted on, what's pending review, and what's planned. Delivered at the configured day and time.

**`activeHours`** — Invalid values (a start/end that isn't `HH:MM`, or a bad IANA timezone) don't disable the plugin: it falls back to the defaults and emits a `config_invalid` event. Overnight windows (start later than end, e.g. `22:00`–`06:00`) are supported.

Full key-by-key reference: [docs/configuration.md](../docs/configuration.md).

### Output files

Relative paths resolve under the agent workspace dir (`<workspace>/`), not `~/.openclaw` — see ["Where files live"](../README.md#where-files-live). Absolute and `~/` overrides in config are honored.

| File | Purpose |
|------|---------|
| `<workspace>/sapience/calibration.json` | Autonomy calibration profile (shared with `sapience-feedback`) |
| `<workspace>/sapience/processed-passes.json` | Tracks which proactive-thinking passes have been routed |
| `<workspace>/sapience/action-log.md` | Log of every Act-tier item delivered |
| `<workspace>/sapience/events.jsonl` | Unified event log (all suite plugins append here) |
| `<workspace>/sapience/dashboard.md` | Auto-generated dashboard, regenerated every routing pass |
| `<workspace>/sapience/digest-state.json` | Date the weekly digest last went out |

`action-log.md` rotates at 5 MB (newest 500 lines kept, previous contents in `action-log.md.old`); `events.jsonl` rotates to timestamped archives with only the newest two archives kept. If a JSON state file is corrupt, it's quarantined to `<name>.corrupt-<timestamp>` and rebuilt.

## Training: calibrating autonomy

Calibration is the process of teaching the agent your preferences per domain and action type.

### Learning mode

When sapience sees a domain/action-class combination with no calibration data (or low confidence), it fires a **Learning** prompt instead of acting:

> "I noticed [item]. My instinct is to surface this as a proposal. Is that the right level of initiative, or would you prefer I handle this differently?"

You respond to confirm or redirect. The calibration profile updates accordingly.

### How confidence builds

| Event | Effect |
|-------|--------|
| You confirm the proposed approach ("yes, that's right") | Confidence +0.1 |
| You correct the approach ("no, just do it") | Confidence −0.3, tier updated |
| No feedback | Confidence unchanged |

Confidence caps at 1.0 and floors at 0.0. A domain needs roughly 3–5 confirmations to reach the default threshold (0.4) from zero.

### Reading the calibration profile

```bash
cat <workspace>/sapience/calibration.json
```

Each entry:
```json
{
  "domain": "github",
  "action_class": "github/action",
  "tier": "propose",
  "confidence": 0.7,
  "confirmed_count": 4,
  "corrected_count": 1,
  "last_calibrated": "2026-05-20T14:00:00Z",
  "notes": ""
}
```

### Resetting a domain

Delete the entry from `calibration.json` to reset a domain to Learning mode.

## Day-to-day use

Once installed, the suite runs in the background. What you'll see in your sessions:

- `[SAPIENCE: PROPOSE]` — a proposal needing your yes/no
- `[SAPIENCE: ACT]` — notification of something just done
- `[SAPIENCE: ASK]` — a question needed before proceeding
- `[SAPIENCE: EXPLORE]` — a problem with options for you to choose from
- `[SAPIENCE: CALIBRATE]` — a calibration question for a new domain
- `[SAPIENCE: WEEKLY DIGEST]` — Friday summary of actions, pending items, and plans

All deliveries are **next-turn injections into your main session** (session key `agent:<id>:main`): the routing cron enqueues them, and they appear the next time you take a turn — not as a push. If the injection fails, a `delivery_failed` event is recorded in `events.jsonl`.

### Weekly digest

Every Friday at 5pm (or your configured `digest.day`/`digest.time` — minutes are honored, `17:45` means 17:45), the digest summarizes:
- What was acted on this week
- Proposals still waiting on your input
- What's planned for next week

The digest fires on the first routing run at or after the configured time on the configured day, at most once per day (tracked in `<workspace>/sapience/digest-state.json`). If a slot was missed — say the gateway was down at 17:00 — it catches up later the same day.

## Troubleshooting

Start with the diagnostic command — it checks plugins, crons (including tool grants), output-file freshness, memory config, and version skew:

```bash
openclaw sapience doctor
```

See [docs/troubleshooting.md](../docs/troubleshooting.md) for the full guide.

**Nothing being delivered to my session**
Check that sapience-thinking is writing `proposals.jsonl`:
```bash
tail -1 <workspace>/proactive-thinking/proposals.jsonl | python3 -m json.tool
```
If the file is empty or missing, sapience-thinking isn't running — run the doctor. Also remember deliveries are next-turn injections: they only show up when you next interact with your main session.

**Everything is going to Learning mode**
Expected behavior for the first week or two. Each calibration response builds confidence. If it continues beyond 2–3 weeks for a domain you use daily, check `calibration.json` — entries may not be getting written.

**Calibration profile not updating**
Feedback plugin (`sapience-feedback`) handles explicit correction/confirmation capture. If it's not installed, calibrations only happen through the Learning mode prompts. Install `sapience-feedback` for passive capture from chat messages.

**`domainFloors` not respected**
Floors only prevent routing *above* the floor — they don't push Act-tier items down to propose. `"github": "propose"` means github/action can be at most `propose`, `ask`, or `explore`, never `act`. If you're seeing Act-tier github items, check the floor config key matches the domain name exactly (lowercase).

**processed-passes.json is missing or was corrupt**
Nothing gets re-delivered. A corrupt file is quarantined to `processed-passes.json.corrupt-<timestamp>`, and a missing/empty processed set triggers a bootstrap that marks **all** existing passes as processed — routing resumes with the next new pass. The cost of losing this file is skipping any genuinely-unrouted passes, not duplicates.

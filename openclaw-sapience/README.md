# Sapience Suite for OpenClaw

The Sapience Suite transforms OpenClaw from a reactive assistant into a proactive agent with genuine autonomy. It learns when to act, when to propose, when to ask, and when to explore — calibrated to your actual preferences, not a static policy you had to configure upfront.

The suite has four plugins that each work independently and compose into a whole:

| Plugin | Does |
|--------|------|
| `openclaw-proactive-thinking` | Periodic thinking passes; generates observations and proposals |
| `openclaw-sapience` *(this plugin)* | Routes proposals through autonomy tiers; calibrates to your preferences; delivers weekly digest |
| `openclaw-feedback` | Captures corrections and confirmations from chat; recalibrates autonomy profile |
| `openclaw-goals` | Accepts fuzzy long-running goals; decomposes them; tracks progress; weekly status |

## How it works

`openclaw-proactive-thinking` runs a thinking pass every 15 minutes and writes proposals to `proposals.jsonl`. `openclaw-sapience` reads that sidecar, routes each proposal through an autonomy decision function, and delivers it to your main session at the right level:

- **Act** — high-confidence, reversible, low-blast-radius → done immediately, brief notification
- **Propose** — worth doing, needs your approval → surfaces it for a yes/no
- **Ask** — agent can do it but needs one piece of information → asks exactly what's needed
- **Explore** — the problem is real but the right path is unclear → presents 2–3 options with tradeoffs
- **Learning** — new domain or low confidence → calibration question before acting

The routing decision uses a calibration profile: per-domain, per-action-class entries with a confidence score. Until a domain is calibrated, everything goes through **Learning** mode and will ask you to confirm it's choices before acting.

## Setup

### Prerequisites

Install `openclaw-proactive-thinking` first. Sapience reads its output.

### Install order

```bash
openclaw plugins install local:/path/to/openclaw-proactive-thinking
openclaw plugins install local:/path/to/openclaw-sapience
openclaw plugins install local:/path/to/openclaw-feedback   # optional
openclaw plugins install local:/path/to/openclaw-goals       # optional
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

### Output files

| File | Purpose |
|------|---------|
| `~/.openclaw/sapience/calibration.json` | Autonomy calibration profile (shared with `openclaw-feedback`) |
| `~/.openclaw/sapience/processed-passes.json` | Tracks which proactive-thinking passes have been routed |
| `~/.openclaw/sapience/action-log.md` | Log of every Act-tier item delivered |

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
cat ~/.openclaw/sapience/calibration.json
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

You don't need to do anything to receive these — they arrive as injected turns in your active session.

### Weekly digest

Every Friday at 5pm (or your configured time), the digest summarizes:
- What was acted on this week
- Proposals still waiting on your input
- What's planned for next week

## Troubleshooting

**Nothing being delivered to my session**
Check that proactive-thinking is writing `proposals.jsonl`:
```bash
cat ~/.openclaw/proactive-thinking/proposals.jsonl | tail -1 | python3 -m json.tool
```
If the file is empty or missing, proactive-thinking isn't running. Check its logs first.

**Everything is going to Learning mode**
Expected behavior for the first week or two. Each calibration response builds confidence. If it continues beyond 2–3 weeks for a domain you use daily, check `calibration.json` — entries may not be getting written.

**Calibration profile not updating**
Feedback plugin (`openclaw-feedback`) handles explicit correction/confirmation capture. If it's not installed, calibrations only happen through the Learning mode prompts. Install `openclaw-feedback` for passive capture from chat messages.

**`domainFloors` not respected**
Floors only prevent routing *above* the floor — they don't push Act-tier items down to propose. `"github": "propose"` means github/action can be at most `propose`, `ask`, or `explore`, never `act`. If you're seeing Act-tier github items, check the floor config key matches the domain name exactly (lowercase).

**Duplicate deliveries**
`processed-passes.json` tracks which proactive-thinking passes have been routed. If it's missing or corrupt, passes get re-delivered. Delete it and it will rebuild from the current pass forward.

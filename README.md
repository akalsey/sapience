# Sapience Suite

Five OpenClaw plugins that transform a reactive assistant into a proactive agent that learns how you work, remembers what matters, and acts with calibrated autonomy.

---

## The problem with reactive AI

Most AI coding assistants wait for you to ask. That model works for well-scoped tasks — "fix this bug," "write this function" — but it breaks down for the kind of ambient intelligence that makes an assistant genuinely useful over time.

**What you actually want:**

- The agent should notice that your test coverage has been declining for three weeks — without you asking.
- It should remember the investigation you did last month into the PostHog billing spike so you don't re-run it from scratch.
- It should know that you never want it to push to main without a PR, and that this preference should persist across every session.
- When you say "improve our OKR scoring rate," it should decompose that into concrete approaches and track progress — not treat it as a one-off request.
- It should act on obvious things without asking permission every time, while still checking before touching anything sensitive.

None of this requires more context in a single session. It requires a different architecture: one where the agent thinks in the background, remembers across sessions, learns your preferences from feedback, and pursues goals you've set.

That's the sapience suite.

---

## What's included

| Plugin | Does |
|--------|------|
| `openclaw-thinking` | Runs periodic isolated "thinking passes" every 15 minutes. Generates structured proposals — observations, suggested actions, audits, open questions — and writes them to a sidecar file for the routing layer to process. |
| `openclaw-sapience` | Routes proposals through autonomy tiers based on blast radius, reversibility, and calibrated confidence. Act on the obvious. Surface the uncertain. Ask before anything sensitive. Delivers a weekly digest. |
| `openclaw-feedback` | Scans your messages for corrections and confirmations. "Don't push to main without a PR" automatically drops confidence for that domain. "Yes, exactly" reinforces the pattern. No manual calibration file to manage. |
| `openclaw-goals` | Accepts fuzzy long-running objectives, decomposes them into concrete approaches, and delivers a weekly status update per goal. "Improve our OKR scoring rate" becomes a tracked initiative. |

Each plugin works standalone. Together, they compose into a coherent system.

---

## How it's different

**vs. bare OpenClaw**

OpenClaw by itself is a capable reactive assistant. The sapience suite adds the proactive layer: things happen between sessions, not just during them.

**vs. tools that inject everything into context**

Some memory tools preload all stored memories into every session. This burns context on irrelevant material and degrades the quality of the session. `openclaw-memory` loads a small always-relevant core and lets the agent search for detail on demand. You get recall without context bloat.

**vs. static config files**

Systems that ask you to configure autonomy upfront require you to know your preferences before you've seen the agent act. `openclaw-sapience` + `openclaw-feedback` start conservative and calibrate from how you actually respond — confirmations build confidence, corrections drop it. The profile that emerges reflects your real preferences, not your guesses about them.

**vs. one-shot task tools**

Goal trackers and project management tools require you to translate fuzzy objectives into structured tasks. `openclaw-goals` accepts the objective as-is and handles the decomposition, then checks in weekly without you needing to maintain a separate system.

---

## Quickstart

### 1. Install the plugins

Install any or all plugins — they work standalone and detect each other automatically:

```bash
openclaw plugins install npm:@akalsey/openclaw-thinking
openclaw plugins install npm:@akalsey/openclaw-sapience
openclaw plugins install npm:@akalsey/openclaw-feedback
openclaw plugins install npm:@akalsey/openclaw-goals
```

To install from source instead:

```bash
git clone https://github.com/akalsey/sapience.git
cd sapience
for dir in openclaw-thinking openclaw-sapience openclaw-feedback openclaw-goals
    cd $dir && npm install && npm run build && cd ..
    openclaw plugins install ./$dir
end
```

Each plugin works standalone. When sapience is installed alongside thinking, thinking automatically defers direct delivery to sapience's routing layer.

### 2. Start a session

Everything runs automatically. The thinking plugin fires every 15 minutes. Within the first hour you'll see your first proposals delivered to your active session.

The first week is calibration. Proposals will arrive as `[SAPIENCE: CALIBRATE]` questions — the agent is learning what level of initiative you want for each type of action. Answer them and it calibrates. Ignore them and it stays conservative.

---

## Configuration

All plugins work out of the box with defaults. Override per-plugin in your OpenClaw config:

```json
{
  "plugins": {
    "sapience-thinking": {
      "activeHours": { "start": "08:00", "end": "20:00", "timezone": "America/Los_Angeles" }
    },
    "sapience": {
      "autonomy": { "defaultTier": "propose" },
      "digest": { "day": "friday", "time": "17:00" }
    },
    "sapience-goals": {
      "weeklyCheckInDay": "monday",
      "weeklyCheckInTime": "09:00"
    },
    "sapience-memory": {
      "memoryPath": "~/.openclaw/memory"
    }
  }
}
```

Full configuration reference in each plugin's README.

---

## Day-to-day use

**You'll see these in your sessions:**

| Marker | Means |
|--------|-------|
| `[SAPIENCE: ACT]` | Something was just done — brief notification |
| `[SAPIENCE: PROPOSE]` | A proposal waiting for your yes/no |
| `[SAPIENCE: ASK]` | One question needed before the agent proceeds |
| `[SAPIENCE: EXPLORE]` | A problem surfaced with 2–3 options for you to choose from |
| `[SAPIENCE: CALIBRATE]` | A new domain — agent checking what level of initiative you want |
| `[SAPIENCE: WEEKLY DIGEST]` | Friday summary of what happened, what's pending, what's planned |
| `[GOALS: DECOMPOSE]` | New goal detected — agent presenting approaches for you to choose from |
| `[GOALS: WEEKLY STATUS]` | Monday goal check-in — what happened, what's blocked, what's next |

**Giving feedback:**

The feedback plugin captures your corrections and confirmations automatically. Just talk to the agent the way you would with a human:

- `"Don't update Salesforce records without asking"` → confidence drops for that domain
- `"Good call, keep doing that"` → confidence increases
- `"Just do it, you don't need to ask about GitHub actions"` → tier bumped toward Act

**Submitting a goal:**

```bash
echo "Get weekly OKR scoring rates above 80% by end of Q3" >> ~/.openclaw/sapience/goals-inbox.md
```

The next thinking pass picks it up and delivers a decomposition prompt to your session.

---

## Training the autonomy profile

The first two weeks are the most important for calibration. Each `[SAPIENCE: CALIBRATE]` prompt you answer teaches the agent your preferences for that domain. After 3–5 calibrations per domain the agent stops asking and just acts at the calibrated tier.

To see the current calibration state:

```bash
cat ~/.openclaw/sapience/calibration.json
```

To reset a domain and start recalibrating:

```bash
# Delete the entry for that domain from calibration.json
```

---

## Data files

Everything is plain files. Nothing is sent anywhere.

| File | Contents |
|------|----------|
| `~/.openclaw/proactive-thinking/log.md` | All thinking pass output, human-readable |
| `~/.openclaw/proactive-thinking/proposals.jsonl` | Structured proposals for routing |
| `~/.openclaw/sapience/calibration.json` | Autonomy profile per domain |
| `~/.openclaw/sapience/action-log.md` | Log of everything acted on |
| `~/.openclaw/sapience/goals.json` | All goals with status and progress |
| `~/.openclaw/sapience/goals-inbox.md` | Where you write new goals |

---

## Plugin READMEs

Each plugin has its own README with full configuration reference, troubleshooting, and design details:

- [`openclaw-thinking/README.md`](openclaw-thinking/README.md)
- [`openclaw-sapience/README.md`](openclaw-sapience/README.md)
- [`openclaw-feedback/README.md`](openclaw-feedback/README.md)
- [`openclaw-goals/README.md`](openclaw-goals/README.md)

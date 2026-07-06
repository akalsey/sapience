# Sapience Suite

Four OpenClaw plugins that transform a reactive assistant into a proactive agent that learns how you work, remembers what matters, and acts with calibrated autonomy.

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
| `sapience-thinking` | Runs periodic isolated "thinking passes" every 15 minutes over your real session transcripts, memory, goals, and open hypotheses. Generates evidence-graded proposals — observations, suggested actions, audits, open questions — and also notices things *in passing* after substantial task turns. |
| `sapience` | Routes proposals through autonomy tiers based on evidence, reversibility, and calibrated (decaying) confidence. Executes act-tier items in isolated sessions, investigates hunches read-only before surfacing them, keeps a hypothesis ledger, watches metrics you care about, and pushes what matters through your channel. Delivers a weekly digest. |
| `sapience-feedback` | Scans your messages for corrections, confirmations, and method advice. "Don't push to main without a PR" automatically drops confidence for that domain. "Whenever you look at churn, segment by plan tier" becomes a standing analytical playbook. No manual calibration file to manage. |
| `sapience-goals` | Accepts fuzzy long-running objectives, decomposes them into concrete approaches, attaches measurable key results, and delivers a weekly status update per goal — leading with the numbers when a metric is set. |

Each plugin works standalone. Together, they compose into a coherent system.

---

## How it's different

**vs. bare OpenClaw**

OpenClaw by itself is a capable reactive assistant. The sapience suite adds the proactive layer: things happen between sessions, not just during them.

**vs. tools that inject everything into context**

Some memory tools preload all stored memories into every session. This burns context on irrelevant material and degrades the quality of the session. The sapience suite uses OpenClaw's native memory API selectively: `sapience-feedback` writes a behavioral reminder directly into OpenClaw's memory whenever it captures a correction. Future sessions see exactly that pointer — not a dump of everything ever stored.

**vs. static config files**

Systems that ask you to configure autonomy upfront require you to know your preferences before you've seen the agent act. `sapience` + `sapience-feedback` start conservative and calibrate from how you actually respond — confirmations build confidence, corrections drop it. The profile that emerges reflects your real preferences, not your guesses about them.

**vs. one-shot task tools**

Goal trackers and project management tools require you to translate fuzzy objectives into structured tasks. `sapience-goals` accepts the objective as-is and handles the decomposition, then checks in weekly without you needing to maintain a separate system.

---

## Quickstart

### 1. Install

The recommended way is the installer. It checks for and installs the plugins, registers the cron jobs, and sets up the memory configuration the suite needs — prompting before each change:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/akalsey/sapience/HEAD/install.sh)"
```

The installer needs **bash >= 4** (it guards this and exits with a message otherwise). macOS ships bash 3.2 — `brew install bash` first, then run the one-liner with the Homebrew bash (e.g. `/opt/homebrew/bin/bash -c "$(curl ...)"`).

It's interactive and idempotent: it only adds what's missing, so it's safe to re-run after an upgrade. It finishes by running `openclaw sapience doctor` to verify the install.

<details>
<summary>Manual installation</summary>

Install any or all plugins — they work standalone and detect each other automatically:

```bash
openclaw plugins install npm:@akalsey/sapience-thinking
openclaw plugins install npm:@akalsey/sapience
openclaw plugins install npm:@akalsey/sapience-feedback
openclaw plugins install npm:@akalsey/sapience-goals
```

To install from source instead (bash):

```bash
git clone https://github.com/akalsey/sapience.git
cd sapience
for dir in sapience-thinking sapience sapience-feedback sapience-goals; do
    (cd "$dir" && npm install && npm run build)
    openclaw plugins install "./$dir"
done
```

Or in fish:

```fish
git clone https://github.com/akalsey/sapience.git
cd sapience
for dir in sapience-thinking sapience sapience-feedback sapience-goals
    cd $dir; and npm install; and npm run build; and cd ..
    openclaw plugins install ./$dir
end
```

Installing the plugins manually does **not** register the cron jobs or memory configuration — run `install.sh` (or set those up by hand; see [docs/cron-setup.md](docs/cron-setup.md)) for the suite to actually do anything. Restart the gateway after installing or updating plugins — tools don't register until it reloads.

</details>

Each plugin works standalone. When sapience is installed alongside thinking, thinking automatically defers direct delivery to sapience's routing layer.

### 2. Start a session

Everything runs automatically. The thinking plugin fires every 15 minutes during active hours (08:00–20:00 local by default). The first routing run baselines any existing passes rather than delivering them, so expect the first proposals roughly 30–45 minutes in. Most deliveries are **next-turn injections into your main session** — they appear when you next take a turn. High-priority items, notable metric moves, and the weekly digest also **push** through your last active channel, within a daily budget.

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
    "sapience-feedback": {
      "memoryEnabled": true
    },
    "sapience-goals": {
      "weeklyCheckInDay": "monday",
      "weeklyCheckInTime": "09:00"
    }
  }
}
```

Full configuration reference — every key with its default — in [docs/configuration.md](docs/configuration.md).

---

## Day-to-day use

**You'll see these in your sessions:**

| Marker | Means |
|--------|-------|
| `[SAPIENCE: ACT RESULT]` | An autonomous action just executed (or failed) — result and undo path |
| `[SAPIENCE: PROPOSE]` | A proposal waiting for your yes/no |
| `[SAPIENCE: ASK]` | One question needed before the agent proceeds |
| `[SAPIENCE: EXPLORE]` | A problem surfaced with 2–3 options for you to choose from |
| `[SAPIENCE: CALIBRATE]` | A new domain — agent checking what level of initiative you want |
| `[SAPIENCE: WATCH]` | A watched metric moved notably |
| `[SAPIENCE: WEEKLY DIGEST]` | Friday summary of what happened, what's pending, what's planned — ends with one calibration question |
| `[GOALS: DECOMPOSE]` | New goal detected — agent presenting approaches for you to choose from |
| `[GOALS: WEEKLY STATUS]` | Monday goal check-in — what happened, what's blocked, what's next |

**Giving feedback:**

The feedback plugin captures your corrections, confirmations, and method advice automatically. Just talk to the agent the way you would with a human:

- `"Don't update Salesforce records without asking"` → confidence drops for that domain
- `"Good call, keep doing that"` → confidence increases
- `"Just do it, you don't need to ask about GitHub actions"` → tier bumped toward Act
- `"Whenever you look at churn, segment by plan tier"` → recorded as an analytical playbook every future thinking pass applies

**Watching a metric:**

Say `"keep an eye on daily signups"` — the agent calls `watch_metric` and the suite checks the number on a cadence, surfacing notable moves (percent delta vs baseline, or threshold crossings) and staying quiet otherwise. `/sapience watches` lists what's being watched.

**Submitting a goal:**

Just tell the agent — it calls `goal_submit` and the decomposition prompt is delivered immediately. Or append to the inbox file from a script:

```bash
echo "Get weekly OKR scoring rates above 80% by end of Q3" >> <workspace>/goals/inbox.md
```

The next `check_goals` cron run (within 15 minutes, during active hours) picks it up and delivers a decomposition prompt on your next turn.

---

## Training the autonomy profile

The first two weeks are the most important for calibration. Each `[SAPIENCE: CALIBRATE]` prompt you answer teaches the agent your preferences for that domain, and every reaction to a delivered proposal (recorded via `record_outcome`) moves confidence too. After 3–5 calibrations per domain the agent stops asking and just acts at the calibrated tier. Confidence that isn't reinforced decays with a 90-day half-life, so stale trust doesn't linger.

To see the current calibration state, use the chat command (it shows the decayed confidence routing actually uses, grouped by tier):

```
/sapience
/sapience set <domain> <action_class> <act|propose|ask|explore>
```

Or read the raw file:

```bash
cat <workspace>/sapience/calibration.json
```

To reset a domain and start recalibrating:

```bash
# Delete the entry for that domain from calibration.json
```

---

## Where files live

Everything is plain files. Nothing is sent anywhere.

All relative paths in plugin config resolve under the **agent workspace directory** (what `api.runtime.agent.resolveAgentWorkspaceDir` returns for your agent) — *not* under `~/.openclaw`. Docs here write that as `<workspace>/`. Absolute paths and `~/` paths in config are honored as-is if you want the data somewhere else. To see the workspace dir a plugin actually resolved, run `openclaw sapience doctor` (PATHS section).

| File | Contents |
|------|----------|
| `<workspace>/proactive-thinking/log.md` | All thinking pass output, human-readable |
| `<workspace>/proactive-thinking/proposals.jsonl` | Structured proposals for routing |
| `<workspace>/proactive-thinking/outcomes.json` | Proposal outcome tracking |
| `<workspace>/sapience/calibration.json` | Autonomy profile per domain |
| `<workspace>/sapience/action-log.md` | Log of everything acted on |
| `<workspace>/sapience/processed-passes.json` | Which thinking passes have been routed |
| `<workspace>/sapience/digest-state.json` | Last weekly-digest delivery date |
| `<workspace>/sapience/events.jsonl` | Unified event log written by all plugins |
| `<workspace>/sapience/dashboard.md` | Auto-generated dashboard: autonomy progression, heartbeat, recent activity |
| `<workspace>/sapience/feedback.md` | Captured feedback signals |
| `<workspace>/sapience/playbooks.json` | Analytical playbooks taught via method feedback |
| `<workspace>/sapience/hypotheses.json` | Hypothesis ledger — open cases with sightings and evidence |
| `<workspace>/sapience/watches.json` | Metric watches and their reading history |
| `<workspace>/sapience/push-state.json` | Daily channel-push budget tracking |
| `<workspace>/sapience/investigation-state.json` | Daily investigation budget tracking |
| `<workspace>/goals/goals.json` | All goals with status, metrics, and progress |
| `<workspace>/goals/inbox.md` | Where you (or scripts) write new goals |

Large logs rotate automatically at 5 MB (see [docs/observability.md](docs/observability.md)). If a JSON state file is ever unparseable, it's quarantined to `<name>.corrupt-<timestamp>` and rebuilt — `openclaw sapience doctor` reports quarantined files.

---

## More documentation

- [docs/configuration.md](docs/configuration.md) — complete config reference for all four plugins
- [docs/cron-setup.md](docs/cron-setup.md) — the three cron jobs and how to register them manually
- [docs/troubleshooting.md](docs/troubleshooting.md) — `openclaw sapience doctor` and common failure modes
- [docs/observability.md](docs/observability.md) — the dashboard and event log
- [docs/memory-configuration.md](docs/memory-configuration.md) — how corrections persist via OpenClaw memory
- [docs/uninstall.md](docs/uninstall.md) — removing the suite cleanly

Each plugin also has its own README:

- [`sapience-thinking/README.md`](sapience-thinking/README.md)
- [`sapience/README.md`](sapience/README.md)
- [`sapience-feedback/README.md`](sapience-feedback/README.md)
- [`sapience-goals/README.md`](sapience-goals/README.md)

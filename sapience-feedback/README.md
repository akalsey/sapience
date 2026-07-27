# OpenClaw Feedback

You give feedback constantly — correcting a format choice, confirming something worked well, redirecting how the agent handled a decision. This plugin catches those signals from your normal chat messages and makes them permanent.

A correction becomes a calibration. A confirmation reinforces a pattern. The sapience calibration profile updates in real time so the agent's behavior reflects how you actually want it to operate.

This plugin is part of the Sapience Suite that gives your OpenClaw agent genuine agency — not just the ability to execute tasks, but the judgment to know when to act, when to ask, when to propose, and when to say "I'm not sure how you want me to handle this."

This plugin can be used without Sapience if all you want to do is have the agent track and incorporate feedback.

---

## Setup

### Prerequisites

None required. This plugin works standalone.

If `sapience` is also installed, the calibration profile at `<workspace>/sapience/calibration.json` feeds directly into autonomy routing. Without sapience, the profile is still written but nothing reads it.

### Install

```bash
openclaw plugins install npm:@akalsey/sapience-feedback
```

### Configuration

Config lives under `plugins.entries.sapience-feedback.config` — the full path shape; the short `plugins.sapience-feedback` form is silently ignored.

```json
{
  "plugins": {
    "entries": {
      "sapience-feedback": {
        "config": {
          "logPath": "sapience/feedback.md",
          "calibrationPath": "sapience/calibration.json",
          "playbooksPath": "sapience/playbooks.json",
          "memoryEnabled": true,
          "semanticDetection": {
            "enabled": true,
            "minLength": 8,
            "minConfidence": 0.6
          }
        }
      }
    }
  }
}
```

All settings are optional — defaults are used if omitted. Relative paths resolve under the agent workspace dir (`<workspace>/`); absolute and `~/` paths are honored as-is. Full key reference: [docs/configuration.md](../docs/configuration.md).

**`semanticDetection`** controls the LLM-based classifier. When enabled (the default), every user message above `minLength` characters is classified by the agent's default inference provider. Set `enabled: false` to fall back to regex-only matching (useful if you want zero LLM cost on routine chat).

---

## How capture works

Passive capture rides the gateway's message hook: every incoming user message is classified as it arrives. Whether the hook surface was available is recorded as `captureMode` in the plugin's status artifact — `message-hook` means passive capture is live; `command-only` means the gateway didn't expose the hook and only `/feedback` works. `openclaw sapience doctor` warns when capture is degraded to command-only.

## What it detects

Every user message is analyzed by the agent's default inference provider (using `api.runtime.llm.complete` — no separate provider configuration required). The classifier returns structured signals in one of four categories. No trigger words or special syntax — speak normally.

### Corrections

Anything that tells the agent it did something wrong or should do it differently. The classifier picks up direct phrasing ("don't push to main"), rhetorical questions ("did you check the password manager first?"), and implicit critiques ("is there something wrong with the passwords you have?").

**Effect:** Confidence on the matching domain/action-class drops by 0.3.

### Confirmations

Anything that reinforces what the agent just did — agreement, praise, "keep doing that".

**Effect:** Confidence on the matching domain/action-class increases by 0.1.

### Tier adjustments

Instructions about how much autonomy the agent should have. "Just do it" or "stop asking" bumps toward **Act**. "Always check first" or "ask me before doing X" bumps toward **Ask**.

**Effect:** Tier for matching domain/action-class is updated directly.

### Method feedback

Standing rules about *how* to analyze something, rather than how much autonomy to take. "Whenever you look at churn, segment by plan tier." "Always check for outliers before reporting an average."

**Effect:** No confidence change — the rule is appended to the shared analytical playbooks file (`playbooksPath`), and every future thinking pass applies it whenever the data in front of it is relevant. Near-duplicate rules are detected and skipped (`playbook_duplicate` event).

A **one-time directive** is not method feedback. "Go re-check the Q3 numbers and tell me what you find" is a task, not a standing analytical move; stored as a permanent playbook it gets re-read as an unexecuted mandate on every thinking pass and re-proposed forever. The classifier distinguishes the two, and anything too long to be a single analytical move is rejected outright with a `playbook_rejected` event.

If the LLM is unavailable (no `api.runtime.llm` exposed, or the call fails), the plugin falls back to a regex matcher covering the common phrasings. The regex layer is intentionally conservative and misses paraphrases — semantic detection is the primary path.

---

## Explicit feedback: the `/feedback` command

When you want to leave feedback without ambiguity, use the slash command:

```
/feedback always look at the password manager before asking me for credentials
```

The command runs the same classifier and then records the result as a `manual` signal. If the classifier finds no clear signal, the message is still logged as a generic correction in the `general` domain — manual feedback is never discarded.

---

## Domain detection

The LLM extracts a domain slug from the content of your message: `github`, `credentials`, `okr-system`, `salesforce`, etc. When the LLM can't identify anything specific, it returns `general`. The regex fallback uses a shared builtin taxonomy (the same one sapience's routing uses) and is more likely to bucket things into `general`.

The taxonomy is extendable: set `domains: {"<regex>": "<slug>"}` in plugin config — your patterns are checked before the builtins. Set the same key on the `sapience` plugin so feedback lands on domains routing actually emits.

---

## Reading the feedback log

```bash
cat <workspace>/sapience/feedback.md
```

The log rotates at 5 MB (newest 500 lines kept in place, previous contents in `feedback.md.old`).

Each entry shows:
- Signal type (correction / confirmation / tier_adjustment / method)
- Domain and action class affected
- The original message
- Tier adjustment, if any
- Meta-pointer written to memory, for corrections

---

## Meta-memory pointers

For corrections, the plugin calls `api.memory.add` to write a behavioral reminder directly into OpenClaw's native memory:

> "Before working on github / github/action: check feedback log — correction recorded: 'don't push to main without a PR'"

The *write* goes through `api.memory.add` — the same API OpenClaw itself uses — and succeeds whether or not any extra memory plugin is installed. **But a successful write is not enough for the pointer to come back.** For these corrections to actually resurface in future sessions (and for `sapience-thinking` to pick up memory as context), OpenClaw needs the `memory-wiki` layer installed and configured:

| Setting | Value | Why |
|---|---|---|
| `plugins.entries.memory-core.config.dreaming.enabled` | `true` | Background consolidation of memories |
| `plugins.entries.memory-wiki.config.vaultMode` | `"bridge"` | Wiki operates in bridge mode |
| `plugins.entries.memory-wiki.config.bridge.enabled` | `true` | Bridges `memory-core` ↔ wiki so writes become recallable |
| `plugins.entries.memory-wiki.config.search.corpus` | `"all"` | Recall searches across the whole corpus |

The suite installer (`install.sh`) checks for `memory-wiki` and offers to install it and apply these settings. Without them, corrections are written but may never persist or resurface across sessions — the calibration profile still updates, but the behavioral reminders won't reliably come back.

To disable memory writes entirely, set `memoryEnabled: false` in config.

---

## Troubleshooting

**Feedback not being detected**
The plugin only scans messages you send (role: `user`), not the agent's responses. Make sure you're sending the correction as a chat message, not just thinking it.

**Calibration not updating**
Feedback on a domain sapience hasn't routed yet is not dropped: the plugin seeds a conservative calibration entry (`propose` tier, confidence 0, `notes: "created from feedback"`) and applies the signal to it. If `calibration.json` isn't changing at all, check that capture is working (`captureMode` in the doctor output) and look for a quarantined `calibration.json.corrupt-<timestamp>` next to it.

**Feedback getting misclassified or missed**
Raise the bar with `semanticDetection.minConfidence` if the classifier is too noisy; lower it if real feedback is being dropped. To force a recording, use `/feedback <text>` — manual entries bypass the confidence threshold.

**LLM cost concerns**
Every user message above `minLength` characters incurs one classifier call. To disable, set `semanticDetection.enabled: false` — the plugin will fall back to the regex matcher with no LLM calls.

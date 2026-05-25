# OpenClaw Feedback

You give feedback constantly — correcting a format choice, confirming something worked well, redirecting how the agent handled a decision. This plugin catches those signals from your normal chat messages and makes them permanent.

A correction becomes a calibration. A confirmation reinforces a pattern. The sapience calibration profile updates in real time so the agent's behavior reflects how you actually want it to operate.

This plugin is part of the Sapience Suite that gives your OpenClaw agent genuine agency — not just the ability to execute tasks, but the judgment to know when to act, when to ask, when to propose, and when to say "I'm not sure how you want me to handle this."

This plugin can be used without Sapience if all you want to do is have the agent track and incorporate feedback.

---

## Setup

### Prerequisites

None required. This plugin works standalone.

If `sapience` is also installed, the calibration profile at `~/.openclaw/sapience/calibration.json` feeds directly into autonomy routing. Without sapience, the profile is still written but nothing reads it.

### Install

```bash
openclaw plugins install npm:@akalsey/sapience-feedback
```

### Configuration

```json
{
  "plugins": {
    "sapience-feedback": {
      "logPath": "~/.openclaw/sapience/feedback.md",
      "calibrationPath": "~/.openclaw/sapience/calibration.json",
      "memoryEnabled": true,
      "semanticDetection": {
        "enabled": true,
        "minLength": 8,
        "minConfidence": 0.6
      }
    }
  }
}
```

All settings are optional — defaults are used if omitted.

**`semanticDetection`** controls the LLM-based classifier. When enabled (the default), every user message above `minLength` characters is classified by the agent's default inference provider. Set `enabled: false` to fall back to regex-only matching (useful if you want zero LLM cost on routine chat).

---

## What it detects

Every user message is analyzed by the agent's default inference provider (using `api.runtime.llm.complete` — no separate provider configuration required). The classifier returns structured signals in one of three categories. No trigger words or special syntax — speak normally.

### Corrections

Anything that tells the agent it did something wrong or should do it differently. The classifier picks up direct phrasing ("don't push to main"), rhetorical questions ("did you check the password manager first?"), and implicit critiques ("is there something wrong with the passwords you have?").

**Effect:** Confidence on the matching domain/action-class drops by 0.3.

### Confirmations

Anything that reinforces what the agent just did — agreement, praise, "keep doing that".

**Effect:** Confidence on the matching domain/action-class increases by 0.1.

### Tier adjustments

Instructions about how much autonomy the agent should have. "Just do it" or "stop asking" bumps toward **Act**. "Always check first" or "ask me before doing X" bumps toward **Ask**.

**Effect:** Tier for matching domain/action-class is updated directly.

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

The LLM extracts a domain slug from the content of your message: `github`, `credentials`, `okr-system`, `salesforce`, etc. When the LLM can't identify anything specific, it returns `general`. The regex fallback uses a fixed keyword table and is more likely to bucket things into `general`.

---

## Reading the feedback log

```bash
cat ~/.openclaw/sapience/feedback.md
```

Each entry shows:
- Signal type (correction / confirmation / tier_adjustment)
- Domain and action class affected
- The original message
- Tier adjustment, if any
- Meta-pointer written to memory, for corrections

---

## Meta-memory pointers

For corrections, the plugin calls `api.memory.add` to write a behavioral reminder directly into OpenClaw's native memory:

> "Before working on github / github/action: check feedback log — correction recorded: 'don't push to main without a PR'"

Future sessions surface this pointer automatically through OpenClaw's standard memory system. No separate memory plugin is required — memory writes go through the same API OpenClaw itself uses.

To disable memory writes, set `memoryEnabled: false` in config.

---

## Troubleshooting

**Feedback not being detected**
The plugin only scans messages you send (role: `user`), not the agent's responses. Make sure you're sending the correction as a chat message, not just thinking it.

**Calibration not updating**
Check that `calibration.json` exists and has an entry for the domain you're correcting. Feedback only updates *existing* entries — it doesn't create new ones. New domains are created by `sapience` when it first routes a proposal in that domain.

**Feedback getting misclassified or missed**
Raise the bar with `semanticDetection.minConfidence` if the classifier is too noisy; lower it if real feedback is being dropped. To force a recording, use `/feedback <text>` — manual entries bypass the confidence threshold.

**LLM cost concerns**
Every user message above `minLength` characters incurs one classifier call. To disable, set `semanticDetection.enabled: false` — the plugin will fall back to the regex matcher with no LLM calls.

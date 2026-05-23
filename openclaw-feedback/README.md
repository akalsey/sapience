# OpenClaw Feedback

You give feedback constantly — correcting a format choice, confirming something worked well, redirecting how the agent handled a decision. This plugin catches those signals from your normal chat messages and makes them permanent.

A correction becomes a calibration. A confirmation reinforces a pattern. The sapience calibration profile updates in real time so the agent's behavior reflects how you actually want it to operate.

This plugin is part of the Sapience Suite that gives your OpenClaw agent genuine agency — not just the ability to execute tasks, but the judgment to know when to act, when to ask, when to propose, and when to say "I'm not sure how you want me to handle this."

This plugin can be used without Sapience if all you want to do is have the agent track and incorporate feedback.

---

## Setup

### Prerequisites

None required. This plugin works standalone.

If `openclaw-sapience` is also installed, the calibration profile at `~/.openclaw/sapience/calibration.json` feeds directly into autonomy routing. Without sapience, the profile is still written but nothing reads it.

### Install

```bash
openclaw plugins install npm:@akalsey/openclaw-feedback
```

### Configuration

```json
{
  "plugins": {
    "sapience-feedback": {
      "logPath": "~/.openclaw/sapience/feedback.md",
      "calibrationPath": "~/.openclaw/sapience/calibration.json",
      "memoryEnabled": true
    }
  }
}
```

All settings are optional — defaults are used if omitted.

---

## What it detects

The plugin scans every message you send for three types of signals:

### Corrections

Phrases that express "don't do that" or "do it differently":

- `don't update OKRs for other teams without asking`
- `stop doing that`
- `never push to main without a PR`
- `use the company template, not the default`
- `you shouldn't have done that without checking`

**Effect:** Confidence on the matching domain/action-class drops by 0.3.

### Confirmations

Phrases that express "yes, that was right":

- `yes exactly`
- `good call`
- `perfect, keep doing that`
- `that's exactly right`

**Effect:** Confidence on the matching domain/action-class increases by 0.1.

### Tier adjustments

Explicit instructions about how much autonomy you want:

- `just do it` / `you don't need to ask` → bumps toward **Act**
- `always ask me first` / `ask me before touching X` → bumps toward **Ask**

**Effect:** Tier for matching domain/action-class is updated directly.

---

## Domain detection

The plugin extracts domains from context in your message:

| Text contains | Domain |
|---------------|--------|
| `github`, `PR`, `push` | `github` |
| `Salesforce` | `salesforce` |
| `PostHog` | `posthog` |
| `Slack` | `slack` |
| `slides`, `deck` | `slides` |
| `OKR` | `okr-system` |
| `Linear` | `linear` |
| (nothing matched) | `general` |

Domain detection is keyword-based, not semantic. Be explicit when giving feedback: "don't update Salesforce records" works better than "don't do that" (which routes to `general`).

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
Check that `calibration.json` exists and has an entry for the domain you're correcting. Feedback only updates *existing* entries — it doesn't create new ones. New domains are created by `openclaw-sapience` when it first routes a proposal in that domain.

**Domain matching to "general" when it shouldn't**
Add more specific keywords to your feedback message. "Don't do that" → "Don't update the Salesforce contact without asking."

**Too many false positives in the feedback log**
The pattern matching is intentionally broad. If casual phrases are being captured incorrectly, check the log and note which patterns are misfiring. You can't currently tune the patterns without modifying `src/feedback-parser.ts`.

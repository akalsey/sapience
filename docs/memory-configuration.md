# Memory Configuration

Sapience uses OpenClaw's native memory API to persist behavioral corrections across sessions. This document covers what gets written, how to configure it, and what OpenClaw settings are required.

---

## How sapience uses memory

Only one plugin writes to memory: `sapience-feedback`.

When it detects a **correction** in your messages (e.g., "don't push to main without a PR"), it calls `api.memory.add` to write a meta-pointer reminder into OpenClaw's memory store:

```
Before working on github / github/action: check feedback log — correction recorded: "don't push to main without a PR"
```

This pointer surfaces in future sessions before the agent works in that domain, even if the calibration confidence hasn't yet dropped below the routing threshold. It's a belt-and-suspenders mechanism: the calibration profile handles long-run behavior, the memory pointer handles the immediate next session.

Confirmations and tier adjustments are **not** written to memory — only corrections.

---

## What gets stored

Each memory entry has the following shape:

```json
{
  "content": "Before working on {domain} / {action_class}: check feedback log — correction recorded: \"{first 80 chars of message}\"",
  "metadata": {
    "tags": ["feedback", "behavioral-correction", "{domain}"],
    "source": "feedback"
  }
}
```

The `domain` tag matches the domain detected from the correction (e.g., `github`, `salesforce`, `general`). You can use this tag to query corrections for a specific domain via `api.memory.search`.

---

## OpenClaw memory prerequisites

Sapience calls `api.memory?.add(...)` — the optional chaining means it silently skips if the memory API is unavailable. No errors, no warnings. If corrections aren't surfacing in future sessions, memory is likely not enabled.

OpenClaw's memory system must be active. In your OpenClaw gateway config (`~/.openclaw/config.json` or equivalent), ensure memory is enabled:

```json
{
  "memory": {
    "enabled": true
  }
}
```

See the [OpenClaw memory documentation](https://docs.openclaw.ai/concepts/memory) for the full configuration reference, including storage backends and retention settings.

---

## sapience-feedback configuration

| Option | Default | Effect |
|--------|---------|--------|
| `memoryEnabled` | `true` | Whether corrections are written to OpenClaw's memory API. Set to `false` to disable. |

To disable memory writes while keeping everything else:

```json
{
  "plugins": {
    "sapience-feedback": {
      "memoryEnabled": false
    }
  }
}
```

Memory writes are independent of the feedback log and calibration profile — disabling `memoryEnabled` does not affect those.

---

## Verifying memory writes

After giving a correction ("don't update Salesforce records without asking"), you can confirm the write happened by searching OpenClaw's memory:

```bash
openclaw memory search "behavioral-correction"
```

Or filter by domain:

```bash
openclaw memory search "behavioral-correction salesforce"
```

Each result should show the meta-pointer text and the `feedback` source tag.

---

## What sapience does NOT use memory for

- **Calibration profile** — stored in `~/.openclaw/sapience/calibration.json`, not in memory
- **Thinking proposals** — written to `proposals.jsonl`, not in memory
- **Goal state** — stored in `goals.json`, not in memory
- **Action log** — written to `action-log.md`, not in memory

Memory is narrowly scoped to behavioral correction pointers. Everything else uses plain files.

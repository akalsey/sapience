---
"@akalsey/sapience": minor
---

Detect and fix the core goal-tool name collision. A new TOOLS doctor section reports when core's `create_goal` / `get_goal` / `update_goal` are reachable in agent sessions alongside sapience-goals — they track a per-thread token budget that dies with the session, so an agent asked for a long-running goal that picks `create_goal` loses it silently.

The fix adds them to `tools.deny`, merged with any existing entries rather than replacing the array. It only fires when the tools are actually reachable (the `minimal` and `messaging` profiles already exclude them) and only when sapience-goals is installed.

Also adds `--fix --only <finding-id>` so a caller can apply one finding in isolation. `install.sh` uses it to offer this fix on its own — denying the tools affects every session on the host, so it stays behind an explicit prompt rather than riding along with the other auto-fixes.

# Uninstalling the Sapience Suite

## 1. Remove the plugins

```bash
openclaw plugins uninstall sapience-thinking
openclaw plugins uninstall sapience
openclaw plugins uninstall sapience-feedback
openclaw plugins uninstall sapience-goals
```

Restart the gateway afterward so the tools deregister.

## 2. Delete the cron jobs

```bash
openclaw cron delete --name sapience-thinking
openclaw cron delete --name sapience-routing
openclaw cron delete --name sapience-goals-check
```

If you installed for multiple agents, the jobs are suffixed `<base>-<agent>` (e.g. `sapience-thinking-research`) — list them and delete each:

```bash
openclaw cron list --json | jq -r '.[].name' | grep '^sapience'
```

## 3. Delete the data (optional)

All suite data lives in three directories under the agent workspace dir:

```bash
rm -rf <workspace>/sapience
rm -rf <workspace>/proactive-thinking
rm -rf <workspace>/goals
```

This removes the calibration profile, event log, dashboard, action log, feedback log, thinking logs/proposals, goals, and any rotated `.old` / quarantined `.corrupt-*` files. The doctor's status artifacts live separately under `~/.openclaw/sapience/status/` — remove that too if you're being thorough.

Keep `<workspace>/sapience/calibration.json` if you might reinstall: it's the learned autonomy profile, and it's just JSON.

## 4. Revert memory configuration (optional)

The installer may have enabled memory settings for the suite. They're generally useful beyond sapience, but to revert:

```bash
openclaw config set plugins.memory-core.dreaming.enabled false --strict-json
openclaw config set plugins.memory-wiki.bridge.enabled false --strict-json
```

And if you installed memory-wiki solely for the suite:

```bash
openclaw plugins uninstall memory-wiki
```

Memory entries already written by sapience-feedback (tagged `behavioral-correction`) remain in OpenClaw's memory store; remove them through OpenClaw's memory tooling if desired.

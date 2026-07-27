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
openclaw cron delete --name sapience-delivery
```

Accepted audit proposals register their own recurring jobs named `sapience-audit-<slug>` — delete those too. If you installed for multiple agents, the jobs are suffixed `<base>-<agent>` (e.g. `sapience-thinking-research`). List everything suite-created and delete each:

```bash
openclaw cron list --json | jq -r '.[].name' | grep '^sapience'
```

## 3. Delete the data (optional)

All suite data lives in three directories under the agent workspace dir, plus two things written outside them:

```bash
rm -rf <workspace>/sapience
rm -rf <workspace>/proactive-thinking
rm -rf <workspace>/goals
rm -f  <workspace>/skill-proposals.md          # human-readable skill specs
rm -rf <workspace>/skills/goal-*               # temporary per-goal skills
```

This removes the calibration profile, event log, dashboard, action log, feedback log, thinking logs/proposals, goals, hypothesis and skill-proposal ledgers, the pending-delivery queue, and any rotated `.old` / quarantined `.corrupt-*` files. The doctor's status artifacts live separately under `~/.openclaw/sapience/status/` — remove that too if you're being thorough.

Goal skills are normally retired automatically when a goal completes; the glob above catches any left behind by goals that were still active at uninstall.

Keep `<workspace>/sapience/calibration.json` if you might reinstall: it's the learned autonomy profile, and it's just JSON.

## 4. Remove suite config keys (optional)

If the installer or `doctor --fix` set a delivery target, the keys stay in your config after the plugins are gone:

```bash
openclaw config get plugins.entries.sapience.config.delivery.sessionKey
openclaw config file    # then delete the plugins.entries.sapience* blocks
```

Orphaned plugin config is inert once the plugins are uninstalled, so this is cosmetic — but the same blocks would be picked up again by a later reinstall.

## 5. Revert memory configuration (optional)

The installer may have enabled memory settings for the suite. They're generally useful beyond sapience, but to revert:

```bash
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json
openclaw config set plugins.entries.memory-wiki.config.bridge.enabled false --strict-json
```

And if you installed memory-wiki solely for the suite:

```bash
openclaw plugins uninstall memory-wiki
```

Memory entries already written by sapience-feedback (tagged `behavioral-correction`) remain in OpenClaw's memory store; remove them through OpenClaw's memory tooling if desired.

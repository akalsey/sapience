# Cron Setup

The suite does nothing without its cron jobs. Three jobs drive everything, all on a 15-minute schedule (`*/15 * * * *`), all running in **isolated sessions**:

| Job | Calls | Belongs to |
|-----|-------|------------|
| `sapience-thinking` | `get_thinking_context`, `record_thinking_output` | sapience-thinking |
| `sapience-routing` | `process_proposals` | sapience |
| `sapience-goals-check` | `check_goals` | sapience-goals |

`install.sh` registers these for you, and `openclaw sapience doctor --fix` re-registers missing ones. This page is for doing it by hand.

## The `--tools` flag is not optional

Isolated cron sessions only see plugin tools that the job's `payload.toolsAllow` grants (`--tools`) — or that a global `tools.alsoAllow: ["group:plugins"]` grants when a `tools.profile` is set. A job registered without its grant runs "ok" on every schedule while the agent can't call the tool and nothing is ever written. See [troubleshooting](troubleshooting.md#tool-exposure-in-cron-sessions).

Also: don't pin a `--model`. A pinned model outside the `agents.defaults.models` allowlist fails cron preflight on every run. Let the job inherit the agent's default.

## Manual registration

These are the exact commands `install.sh` runs (agent `main`; substitute yours):

```bash
openclaw cron add \
  --name "sapience-thinking" \
  --cron "*/15 * * * *" \
  --session isolated \
  --agent "main" \
  --no-deliver \
  --tools "get_thinking_context,record_thinking_output" \
  --message "You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions. If it returns {status:skip}, reply with SILENT_REPLY_TOKEN and stop. Otherwise review the context carefully, then call record_thinking_output() with your proposals. Do not produce any other output. If the tool is not available, reply SILENT_REPLY_TOKEN and stop." \
  --timeout-seconds 120
```

```bash
openclaw cron add \
  --name "sapience-routing" \
  --cron "*/15 * * * *" \
  --session isolated \
  --agent "main" \
  --no-deliver \
  --tools "process_proposals" \
  --message "You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals. Reply SILENT_REPLY_TOKEN after the tool call. If the tool is not available, reply SILENT_REPLY_TOKEN and stop." \
  --timeout-seconds 120
```

```bash
openclaw cron add \
  --name "sapience-goals-check" \
  --cron "*/15 * * * *" \
  --session isolated \
  --agent "main" \
  --no-deliver \
  --tools "check_goals" \
  --message "You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply SILENT_REPLY_TOKEN after the tool call. If the tool is not available, reply SILENT_REPLY_TOKEN and stop." \
  --timeout-seconds 120
```

The 15-minute cadence lives entirely in these jobs — the plugins' `schedule` config key is not read by any code. Active-hours gating happens inside the tools: outside the configured window the cron still fires but the tool skips silently.

## Multi-agent installs

When registering for more than one agent, the installer names jobs `<base>-<agent>` (e.g. `sapience-thinking-research`) and passes the matching `--agent`. The doctor matches jobs whose name equals the base or starts with `<base>-`.

## Verifying

```bash
openclaw sapience doctor          # checks existence, tool grants, last-run status
openclaw cron list --json         # inspect payload.toolsAllow yourself
```

To repair a job with a missing or wrong tools grant, delete and re-add it:

```bash
openclaw cron delete --name sapience-routing
# then re-run the matching `openclaw cron add` above, or `openclaw sapience doctor --fix`
```

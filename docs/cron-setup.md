# Cron Setup

The suite does nothing without its cron jobs. Four jobs drive everything, all on a 15-minute schedule (`*/15 * * * *`), all running in **isolated sessions**:

| Job | Calls | Belongs to | Delivery |
|-----|-------|------------|----------|
| `sapience-thinking` | `get_thinking_context`, `record_thinking_output` | sapience-thinking | `--no-deliver` |
| `sapience-routing` | `process_proposals` | sapience | `--no-deliver` |
| `sapience-goals-check` | `check_goals` | sapience-goals | `--no-deliver` |
| `sapience-delivery` | `get_pending_deliveries` | sapience | `--announce` |

`install.sh` registers these for you, and `openclaw sapience doctor --fix` re-registers missing ones. This page is for doing it by hand.

## The delivery job is different

The first three jobs do their work through tools and never speak — hence `--no-deliver`. The **delivery** job is the suite's channel-reaching fallback: it drains the pending-delivery queue (`<workspace>/sapience/pending-deliveries.json`) that routing writes whenever a main-session injection fails or a routing cycle overflows its `delivery.maxPerCycle` cap, and composes the items into one message. Its final reply must actually reach you, so it is registered with `--announce` — cron announce delivery is the one channel path stock openclaw grants globally-installed plugins (main-session injection is voided by the gateway's registration guard).

Announce's default target resolves from the **main** session's delivery context. On installs where `session.dmScope` isolates DMs into per-peer sessions, the main session never gains a route and announce fails closed. Pin an explicit destination in that case — `install.sh` reads two env vars and passes them through:

```bash
SAPIENCE_DELIVERY_CHANNEL=telegram SAPIENCE_DELIVERY_TO=<chatId> \
  /opt/homebrew/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/akalsey/sapience/HEAD/install.sh)"
```

which becomes `--channel telegram --to <chatId>` on the `sapience-delivery` job. The same installs also want a delivery **session key** so injected proposals land in a session a human reads — see [configuration.md](configuration.md#delivery-target) and the doctor's `delivery:target` check.

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
  --message "You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions. If it returns {status:skip}, reply with NO_REPLY and stop. Otherwise review the context carefully, then call record_thinking_output() with your proposals. Do not produce any other output. If the tool is not available, reply NO_REPLY and stop." \
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
  --message "You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop." \
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
  --message "You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop." \
  --timeout-seconds 120
```

```bash
openclaw cron add \
  --name "sapience-delivery" \
  --cron "*/15 * * * *" \
  --session isolated \
  --agent "main" \
  --announce \
  --tools "get_pending_deliveries" \
  --message "You are the sapience delivery agent. Call get_pending_deliveries() to fetch notifications that could not reach the user through the normal path. If it returns NOTHING_PENDING, reply NO_REPLY and stop. Otherwise compose ONE concise message to the user covering every pending item — lead with the most important, keep it brief, and write as the assistant speaking directly to the user; your final reply is delivered to their chat. If the tool is not available, reply NO_REPLY and stop." \
  --timeout-seconds 120
```

Add `--channel <channel> --to <id>` to the delivery job when announce can't resolve a target on its own (see above).

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

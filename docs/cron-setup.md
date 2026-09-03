# Cron Setup

The suite does nothing without its cron jobs. Five jobs drive everything, all running in **isolated sessions**:

| Job | Payload | Belongs to | Schedule | Delivery |
|-----|---------|------------|----------|----------|
| `sapience-thinking` | `get_thinking_context`, `record_thinking_output` | sapience-thinking | `*/15 * * * *` | `--no-deliver` |
| `sapience-routing` | `process_proposals` | sapience | `*/15 * * * *` | `--no-deliver` |
| `sapience-goals-check` | `check_goals` | sapience-goals | `*/15 * * * *` | `--no-deliver` |
| `sapience-poll-delivery` | command: `openclaw sapience deliver-check` | sapience | `*/15 * * * *` | `--no-deliver` |
| `sapience-delivery` | `get_pending_deliveries` | sapience | on demand (registered disabled) | `--announce`, or a pinned target |

`install.sh` registers these for you, and `openclaw sapience doctor --fix` re-registers missing ones. This page is for doing it by hand.

## Supported OpenClaw versions

The suite requires **OpenClaw 2026.7.1 or newer** (`openclaw.install.minHostVersion` in each plugin's manifest; older hosts skip the plugin at load with a warning). `openclaw sapience doctor` prints the detected host version in its `HOST` section and errors below the floor.

Everything the suite registers (`--declaration-key`, `--light-context`, and command payloads) exists in both the 2026.07 and 2026.08 lines, so there is no version-conditional behavior. What changed at 2026.8.1 is how a scheduled job stays quiet, and it changed in three ways.

The recognized silent token narrowed. 2026.7.1 exported `isHeartbeatOnlyResponse()` and `resolveHeartbeatAckMaxChars()`, which suppressed a reply of `HEARTBEAT_OK` plus up to 300 further characters. Both are gone, and the delivery path now recognizes only `NO_REPLY`.

Suppression also became strict about form. A reply of exactly `NO_REPLY` is silent; `Nothing pending. NO_REPLY` delivers the words "Nothing pending."

And producing no text at all stopped being silent. When a model completes a tool call but ends its turn without any assistant text, the runner retries and then substitutes a placeholder sentence. That substitution is final text, so a job with a delivery route delivers it.

So on 2026.8+, a job with a delivery route has exactly one quiet path: a reply consisting of the bare token and nothing else. The suite is arranged so that no job depends on a model finding that path on every run. See "Why delivery is two jobs" below.

## Why delivery is two jobs

The first three jobs do their work through tools and never speak. The **delivery** job is the suite's channel-reaching fallback: it drains the pending-delivery queue (`<workspace>/sapience/pending-deliveries.json`) that routing writes whenever a main-session injection fails or a routing cycle overflows its `delivery.maxPerCycle` cap, and composes the items into one message. Its final reply must actually reach you.

That queue is empty on the great majority of cycles. A 15-minute schedule is 96 runs a day, and on an install we measured, roughly 90 of them existed only to discover there was nothing to do. On 2026.8+ a run that ends without assistant text delivers the host's placeholder sentence — so those 90 runs became 90 messages a day, each one saying nothing.

The queue check therefore moved out of the agent turn:

- **`sapience-poll-delivery`** is a *command payload*. It runs `openclaw sapience deliver-check`, which reads the queue in plugin code — no model, no bootstrap context, no delivery route — and starts the delivery job only when there is something to send. It prints `NO_REPLY` and exits 0 on every path, so it never says anything itself.
- **`sapience-delivery`** is registered **disabled**. It has no schedule of its own; the poll job runs it on demand. `openclaw sapience doctor` reports this state as healthy and warns if the job goes back to running on a schedule.

This uses a command payload rather than OpenClaw's `--trigger-script` condition gate on purpose: trigger scripts require `cron.triggers.enabled`, which grants headless `exec` with the owning agent's full tool policy. Gating a queue read is not worth turning that on.

## Pinning a delivery target (recommended)

`--announce` is OpenClaw's fallback delivery mode: the runner sends the run's final text to a chat target if the agent didn't send anything itself. Its default target, `last`, resolves from the **main** session's delivery context. On installs where `session.dmScope` isolates DMs into per-peer sessions, the main session never gains a route and announce fails closed. Pin an explicit destination — `install.sh` reads two env vars and passes them through:

```bash
SAPIENCE_DELIVERY_CHANNEL=telegram SAPIENCE_DELIVERY_TO=<chatId> \
  /opt/homebrew/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/akalsey/sapience/HEAD/install.sh)"
```

Pinning also buys silence, and the mechanism is worth stating exactly, because it is the only reliable way to get a scheduled job to shut up on 2026.8+.

The runner decides whether a run *must* end in visible text from the job's delivery plan:

```ts
// src/cron/delivery-plan.ts
requested: resolvedMode === "announce",

// src/cron/isolated-agent/run-executor.ts
terminalReplyExpectation:
  params.deliveryRequested === true && params.resolvedDeliveryOk ? "required" : "optional",
```

An `announce` job therefore sets `terminalReplyExpectation: "required"`, and a run that ends with no assistant text gets placeholder text synthesized to satisfy it. No prompt wording prevents that, and neither does a better model — the placeholder appears precisely when the model produced nothing to judge.

`--no-deliver` sets `requested: false` even when `--channel` and `--to` are also present, so the expectation drops to `"optional"` and an empty turn produces nothing at all. The explicit target is still resolved, so the `message` tool has a route to send through. That combination is what a pinned install gets: a real delivery path, and no fallback the runner can fill with placeholder text.

Without a pinned target the job keeps `--announce`, because "last active channel" resolution is the only route an unpinned install has — and it keeps the placeholder hazard with it, on whatever runs the poll job does start.

The same installs also want a delivery **session key** so injected proposals land in a session a human reads — see [configuration.md](configuration.md#delivery-target) and the doctor's `delivery:target` check.

## Declaration keys make registration idempotent

Every job is registered with `--declaration-key sapience:<name>`. OpenClaw matches an existing job carrying the same key and updates it in place, so re-running the installer converges instead of minting a second copy.

Without them, each installer run created a new job — one install accumulated two rows each for three jobs, created eight days apart — and the rename that dropped an older `-pass` suffix orphaned that whole generation rather than migrating it. Those orphans kept running with an announce route and a prompt that asked for the literal string `SILENT_REPLY_TOKEN` (the *name* of OpenClaw's constant, not its value `NO_REPLY`), so they announced on every run. `install.sh` and `openclaw sapience doctor --fix` both offer to delete them.

Multi-agent installs qualify the key per agent (`sapience:routing:research`). Two jobs sharing a key in one caller scope make the match ambiguous, and OpenClaw rejects that outright.

## `--tools` and `--light-context`

Isolated cron sessions only see plugin tools that the job's `payload.toolsAllow` grants (`--tools`) — or that a global `tools.alsoAllow: ["group:plugins"]` grants when a `tools.profile` is set. A job registered without its grant runs "ok" on every schedule while the agent can't call the tool and nothing is ever written. See [troubleshooting](troubleshooting.md#tool-exposure-in-cron-sessions).

Every agent job is registered with `--light-context`, which skips workspace bootstrap file injection. These jobs get their instructions from their prompt and their data from their tool; the operator's agent instructions, long-term memory file and persona documents were costing roughly 15k input tokens per run to make a single tool call.

## Models

Don't pin a `--model` in the plugin. A pinned model outside the `agents.defaults.models` allowlist fails cron preflight on every run.

Do know what these jobs need from a model. Every run has to produce a well-formed structured tool call. That contract breaks on small models: a `gemini-2.5-flash` install produced `MALFORMED_FUNCTION_CALL` on thinking passes, emitting `print(default_api.record_thinking_output(...))` where a tool call belonged.

**A model upgrade fixes malformed tool calls and nothing else.** In particular it does not stop the placeholder messages described under "Why delivery is two jobs". That was tested: the install where this was found moved its delivery job from `gemini-2.5-flash` to `gemini-2.5-pro` and still recorded the placeholder. The failure is model-independent, because it happens precisely when the model produces no text for the host to judge. Don't spend money on a bigger model expecting a quieter chat.

For malformed tool calls, pin a better model **per job** rather than changing your agent default:

```bash
openclaw cron edit <job-id> --model anthropic/claude-sonnet-4-6
```

The model must be in your `agents.defaults.models` allowlist, or the run fails preflight with a validation error instead of falling back. `openclaw sapience doctor` checks exactly this and reports a pinned model that isn't allowed.

Silence, then, cannot come from the model. It comes from the two structural choices above: the poll job means an empty queue never starts a turn, and a pinned delivery target means the job carries no announce route for the runner to fall back to.

## Manual registration

These are the exact commands `install.sh` runs (agent `main`; substitute yours):

```bash
openclaw cron add \
  --name "sapience-thinking" \
  --declaration-key "sapience:thinking" \
  --cron "*/15 * * * *" \
  --session isolated \
  --agent "main" \
  --no-deliver \
  --light-context \
  --tools "get_thinking_context,record_thinking_output" \
  --message "You are running a scheduled thinking pass. Call get_thinking_context() to receive your context and instructions. If it returns {status:skip}, reply with NO_REPLY and stop. Otherwise review the context carefully, then call record_thinking_output() with your proposals. Do not produce any other output. If the tool is not available, reply NO_REPLY and stop." \
  --timeout-seconds 120
```

```bash
openclaw cron add \
  --name "sapience-routing" \
  --declaration-key "sapience:routing" \
  --cron "*/15 * * * *" \
  --session isolated \
  --agent "main" \
  --no-deliver \
  --light-context \
  --tools "process_proposals" \
  --message "You are the sapience routing agent. Call process_proposals() to route new thinking pass proposals. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop." \
  --timeout-seconds 120
```

```bash
openclaw cron add \
  --name "sapience-goals-check" \
  --declaration-key "sapience:goals-check" \
  --cron "*/15 * * * *" \
  --session isolated \
  --agent "main" \
  --no-deliver \
  --light-context \
  --tools "check_goals" \
  --message "You are the goals tracking agent. Call check_goals() to process new goals and deliver weekly status updates. Reply NO_REPLY after the tool call. If the tool is not available, reply NO_REPLY and stop." \
  --timeout-seconds 120
```

The poll job. Its `--command` runs on the Gateway host, so `openclaw` must be on that host's `PATH`:

```bash
openclaw cron add \
  --name "sapience-poll-delivery" \
  --declaration-key "sapience:poll-delivery" \
  --cron "*/15 * * * *" \
  --session isolated \
  --agent "main" \
  --no-deliver \
  --command "openclaw sapience deliver-check" \
  --timeout-seconds 120
```

The delivery job, unpinned (`--disabled` because the poll job starts it):

```bash
openclaw cron add \
  --name "sapience-delivery" \
  --declaration-key "sapience:delivery" \
  --cron "*/15 * * * *" \
  --session isolated \
  --agent "main" \
  --disabled \
  --announce \
  --light-context \
  --tools "get_pending_deliveries" \
  --message "You are the sapience delivery agent. Call get_pending_deliveries() to fetch notifications that could not reach the user through the normal path. If it returns NOTHING_PENDING, reply NO_REPLY and stop. Otherwise compose ONE concise message to the user covering every pending item — lead with the most important, keep it brief, and write as the assistant speaking directly to the user; your final reply is delivered to their chat. If the tool is not available, reply NO_REPLY and stop." \
  --timeout-seconds 120
```

With a pinned target, replace `--announce` with `--no-deliver --channel telegram --to <chatId>`, add `message` to `--tools`, and use this prompt instead:

```
You are the sapience delivery agent. Call get_pending_deliveries() to fetch notifications that could not reach the user through the normal path. If it returns NOTHING_PENDING, reply NO_REPLY and stop. Otherwise compose ONE concise message to the user covering every pending item — lead with the most important, keep it brief, and write as the assistant speaking directly to the user. Send it with the message tool to channel "telegram", target "<chatId>". After the message tool reports success, reply NO_REPLY and stop. If the tool is not available, reply NO_REPLY and stop.
```

The 15-minute cadence lives entirely in these jobs — the plugins' `schedule` config key is not read by any code. Active-hours gating happens inside the tools: outside the configured window the cron still fires but the tool skips silently.

## Generated audit jobs

Accepting an `audit` proposal registers a weekly job named `sapience-audit-<slug>`, with declaration key `sapience:audit:<name>`, `--no-deliver`, and `--light-context`. Its prompt asks for `NO_REPLY` on the nothing-to-report path rather than a one-line clean bill, matching the rest of the suite.

These jobs omit `--agent` entirely so OpenClaw's scheduler resolves the configured default. An earlier version stored the literal string `"default"`, which is a valid agent id only on installs that happen to have an agent by that name — everywhere else every run failed with `cron job agent is unavailable: default`.

## Multi-agent installs

When registering for more than one agent, the installer names jobs `<base>-<agent>` (e.g. `sapience-thinking-research`), passes the matching `--agent`, and qualifies the declaration key with `:<agent>`. The doctor matches jobs whose name equals the base or starts with `<base>-`.

The poll job is named `sapience-poll-delivery`, not `sapience-delivery-poll`, precisely so that prefix match cannot confuse it with a `sapience-delivery-<agent>` copy.

## Verifying

```bash
openclaw sapience doctor          # host version, existence, tool grants, last-run status
openclaw cron list --all --json   # --all: the delivery job is disabled by design
openclaw sapience deliver-check   # run the poll payload by hand; prints NO_REPLY
```

To repair a job, just re-register it. Declaration keys make `cron add` an upsert, so the old delete-then-re-add dance is no longer needed:

```bash
# re-run the matching `openclaw cron add` above, or:
openclaw sapience doctor --fix
```

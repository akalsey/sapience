# Configuration Reference

Every key each plugin reads, with its default. Anything omitted uses the default.

**Where overrides go.** Plugin config lives under `plugins.entries.<plugin-id>.config.<key>` in your OpenClaw config — the full shape, not `plugins.<plugin-id>.<key>`. The CLI rejects the short form, and hand-editing it into the JSON file writes orphan keys the plugin never reads:

```bash
openclaw config set plugins.entries.sapience.config.digest.day '"friday"'
openclaw config set plugins.entries.sapience.config.push.enabled true --strict-json   # booleans/numbers need --strict-json
openclaw config get plugins.entries.sapience.config.digest.day
```

The equivalent JSON:

```json
{
  "plugins": {
    "entries": {
      "sapience": { "config": { "digest": { "day": "friday" } } }
    }
  }
}
```

**Paths:** relative paths resolve under the agent workspace dir (`<workspace>/`, from `api.runtime.agent.resolveAgentWorkspaceDir`). Absolute paths and `~/` paths are used as-is.

**Active hours (all plugins that have them):** `start`/`end` are `HH:MM` in the given IANA timezone. Overnight windows (start later than end) are supported. Invalid values don't disable the plugin — it falls back to the defaults and emits a `config_invalid` event.

**Cadence:** the 15-minute schedule comes from the openclaw cron jobs ([cron-setup.md](cron-setup.md)), not from config. The `schedule` key below exists in the defaults but is not read by any code.

---

## sapience-thinking

| Key | Default | Description |
|-----|---------|-------------|
| `schedule` | `"*/15 * * * *"` | Unused — cadence comes from the cron job |
| `activeHours.start` | `"08:00"` | Passes only run at/after this local time |
| `activeHours.end` | `"20:00"` | ...and at/before this local time |
| `activeHours.timezone` | `"America/Los_Angeles"` | IANA timezone for the window |
| `context.lookbackHours` | `2` | How far back the context bundle looks at recent activity |
| `context.maxContextTokens` | `8000` | Token budget for the context bundle (70% transcripts, 20% memory) |
| `output.logPath` | `"proactive-thinking/log.md"` | Human-readable pass log |
| `output.proposalsPath` | `"proactive-thinking/proposals.jsonl"` | Structured sidecar the sapience router reads (must match its `proactiveThinking.proposalsPath`) |
| `output.trackerPath` | `"proactive-thinking/outcomes.json"` | Proposal outcome tracking |
| `output.eventsPath` | `"sapience/events.jsonl"` | Shared suite event log |
| `delivery.heartbeatTrigger` | `true` | Standalone mode: inject high-priority proposals into the main session (ignored when the sapience router is active) |
| `delivery.priorityThreshold` | `4` | Minimum priority (1–5) for standalone delivery |
| `delivery.maxProposalsPerHeartbeat` | `3` | Cap on proposals per standalone delivery |
| `delivery.sessionKey` | *(unset)* | Explicit target session for injections — see [Delivery target](#delivery-target) |
| `noticing.enabled` | `true` | Post-task incidental noticing: watch live session transcripts and run a cheap side-pass after substantial turns |
| `noticing.minTurnChars` | `1500` | Turns shorter than this (characters) are never noticed on |
| `noticing.cooldownMinutes` | `15` | Minimum gap between noticing passes per session |
| `learning.trackOutcomes` | `true` | Record each proposal in `outcomes.json` |
| `learning.adjustPromptBasedOnSignal` | `true` | Feed signal-to-noise stats back into the thinking prompt |
| `learning.bootstrapDays` | `14` | Days of data required before the signal report kicks in |

Not configurable here: thinking passes read analytical playbooks from `<workspace>/sapience/playbooks.json` (a fixed path). The *write* side of that file is sapience-feedback's `playbooksPath` key.

## sapience

| Key | Default | Description |
|-----|---------|-------------|
| `schedule` | `"*/15 * * * *"` | Unused — cadence comes from the cron job |
| `activeHours.start` | `"08:00"` | Routing only runs at/after this local time |
| `activeHours.end` | `"20:00"` | ...and at/before this local time |
| `activeHours.timezone` | `"America/Los_Angeles"` | IANA timezone for the window |
| `proactiveThinking.proposalsPath` | `"proactive-thinking/proposals.jsonl"` | Where to read sapience-thinking's proposals |
| `learning.enabled` | `true` | Route uncalibrated/low-confidence items to Learning (calibration questions) instead of the tier function |
| `learning.recalibrateOnNewDomain` | `true` | Unused — not read by any code |
| `learning.confidenceDropThreshold` | `0.4` | Below this confidence, Learning fires instead of the calibrated tier |
| `autonomy.defaultTier` | `"propose"` | Tier for uncalibrated items when learning is off; also the tier new calibration entries start at |
| `autonomy.domainFloors` | `{}` | Per-domain minimum tier (e.g. `{"salesforce": "ask"}`) — caps how autonomous a domain can get |
| `digest.enabled` | `true` | Deliver the weekly digest |
| `digest.day` | `"friday"` | Digest day (weekday name) |
| `digest.time` | `"17:00"` | Digest time, `HH:MM` — minutes are honored; fires on the first routing run at/after this, once per day |
| `delivery.maxPerCycle` | `3` | Items injected directly per routing cycle (act-tier first, then priority); the overflow queues for the `sapience-delivery` cron, which composes it into one message |
| `delivery.dedupeWindowHours` | `72` | An item whose normalized text was already delivered within this window is suppressed (`item_suppressed`) instead of re-delivered — the thinking model re-emits the same finding under a fresh id, which pass-id dedupe never catches |
| `delivery.sessionKey` | *(unset)* | Explicit target session for injections — see [Delivery target](#delivery-target) |
| `push.enabled` | `true` | Proactive channel push: wake the agent to deliver high-priority act/propose items through the last active channel instead of waiting for your next turn |
| `push.maxPerDay` | `6` | Push budget per local day (the weekly digest always pushes and doesn't count) |
| `push.minPriority` | `4` | Minimum priority (1–5) for an item to push |
| `investigation.enabled` | `true` | Bounded read-only investigation of hunch-graded items before they surface |
| `investigation.maxPerDay` | `3` | Investigation budget per local day |
| `investigation.minPriority` | `3` | Minimum priority (1–5) for a hunch to be investigated |
| `investigation.timeoutSec` | `120` | Timeout for one investigation subagent run |
| `act.execute` | `true` | Execute act-tier items in isolated subagent sessions at routing time (falls back to legacy main-session injection when the subagent runtime is unavailable) |
| `act.timeoutSec` | `300` | Timeout for one act execution |
| `watch.maxChecksPerRun` | `2` | Cap on metric-watch checks per routing pass |
| `watch.timeoutSec` | `120` | Timeout for one watch-check subagent run |
| `domains` | `{}` | Extra domain taxonomy: `{"<regex>": "<slug>"}` patterns matched against proposal text, checked before the builtins (github, salesforce, posthog, lovable, slack, google-docs, slides, okr-system, linear, credentials) |
| `output.calibrationPath` | `"sapience/calibration.json"` | Autonomy calibration profile |
| `output.actionLogPath` | `"sapience/action-log.md"` | Prose log of Act-tier items |
| `output.processedPassesPath` | `"sapience/processed-passes.json"` | Routed-pass tracking |
| `output.eventsPath` | `"sapience/events.jsonl"` | Shared suite event log |
| `output.dashboardPath` | `"sapience/dashboard.md"` | Auto-generated dashboard |
| `output.goalsPath` | `"goals/goals.json"` | Goals store (read for the dashboard's goals summary) |
| `output.pushStatePath` | `"sapience/push-state.json"` | Daily push budget tracking |
| `output.investigationStatePath` | `"sapience/investigation-state.json"` | Daily investigation budget tracking |
| `output.hypothesesPath` | `"sapience/hypotheses.json"` | Hypothesis ledger — open cases built from recurring hunches |
| `output.watchesPath` | `"sapience/watches.json"` | Metric watches and their reading history |
| `output.pendingDeliveriesPath` | `"sapience/pending-deliveries.json"` | Queue drained by the `sapience-delivery` cron (failed injections + per-cycle overflow) |
| `output.deliveredLedgerPath` | `"sapience/delivered-ledger.json"` | Content hashes of recently delivered items, for `delivery.dedupeWindowHours` |
| `output.skillProposalsPath` | `"sapience/skill-proposals.json"` | Skill-proposal ledger (machine state) |
| `output.skillProposalsDocPath` | `"skill-proposals.md"` | Append-only human-readable specs, at the workspace root where you'd actually read them |

## sapience-feedback

| Key | Default | Description |
|-----|---------|-------------|
| `logPath` | `"sapience/feedback.md"` | Feedback signal log |
| `calibrationPath` | `"sapience/calibration.json"` | Calibration profile to update (shared with sapience) |
| `playbooksPath` | `"sapience/playbooks.json"` | Where method feedback appends analytical playbooks (read by sapience-thinking) |
| `eventsPath` | `"sapience/events.jsonl"` | Shared suite event log |
| `memoryEnabled` | `true` | Write meta-pointer reminders for corrections via `api.memory.add` |
| `domains` | `{}` | Extra domain taxonomy for the regex fallback: `{"<regex>": "<slug>"}`, checked before the builtins — same format as sapience's `domains` key |
| `semanticDetection.enabled` | `true` | Use the LLM classifier; `false` falls back to regex-only matching |
| `semanticDetection.minLength` | `8` | Messages shorter than this (characters) are never classified |
| `semanticDetection.minConfidence` | `0.6` | Classifier signals below this confidence are dropped |

## sapience-goals

| Key | Default | Description |
|-----|---------|-------------|
| `schedule` | `"*/15 * * * *"` | Unused — cadence comes from the cron job |
| `activeHours.start` | `"08:00"` | Goal checks only run at/after this local time |
| `activeHours.end` | `"20:00"` | ...and at/before this local time |
| `activeHours.timezone` | `"America/Los_Angeles"` | IANA timezone for the window (also used to compute weekly check-in dates) |
| `weeklyCheckInDay` | `"monday"` | Weekday for per-goal status deliveries |
| `weeklyCheckInTime` | `"09:00"` | Local time for status deliveries, `HH:MM` |
| `inboxPath` | `"goals/inbox.md"` | Append-only file where new goals can be written externally |
| `inboxPositionPath` | `"goals/inbox-position.json"` | Byte-offset tracker for the inbox — don't edit |
| `skillsDir` | `"skills"` | Where a goal's standing instructions install as a temporary skill (`skills/goal-<id>/SKILL.md`), retired when the goal completes |
| `output.goalsPath` | `"goals/goals.json"` | Goals store |
| `output.eventsPath` | `"sapience/events.jsonl"` | Shared suite event log |
| `delivery.sessionKey` | *(unset)* | Explicit target session for injections — see [Delivery target](#delivery-target) |

---

## Delivery target

Injected deliveries (tier prompts, the digest, goal decomposition and weekly status) go to the agent's **main** session by default — resolved as `agent:<agentId>:<session.mainKey>`, or `global` when `session.scope` is `global`.

That default is wrong on installs where `session.dmScope` isolates DMs into per-peer sessions: the main session is then machine-only, so proposals delivered there ask questions whose answers can never arrive. Set an explicit session key on each delivering plugin:

```bash
for id in sapience sapience-thinking sapience-goals; do
    openclaw config set "plugins.entries.$id.config.delivery.sessionKey" '"agent:main:telegram:direct:12345"'
done
```

`install.sh` detects this at install time and offers to set it from your most recent operator conversation; `openclaw sapience doctor` re-checks it (finding `delivery:target`) and `--fix` applies it — which matters on a fresh install, where no conversation exists yet to point at. Keys are lowercased before use.

This is separate from the `sapience-delivery` cron's `--channel`/`--to` announce target ([cron-setup.md](cron-setup.md#the-delivery-job-is-different)): `delivery.sessionKey` decides where injections land, the announce target decides where the fallback cron's message is sent.

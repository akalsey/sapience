# Configuration Reference

Every key each plugin reads, with its default. Set overrides under `plugins.<plugin-id>` in your OpenClaw config; anything omitted uses the default.

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
| `learning.trackOutcomes` | `true` | Record each proposal in `outcomes.json` |
| `learning.adjustPromptBasedOnSignal` | `true` | Feed signal-to-noise stats back into the thinking prompt |
| `learning.bootstrapDays` | `14` | Days of data required before the signal report kicks in |

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
| `output.calibrationPath` | `"sapience/calibration.json"` | Autonomy calibration profile |
| `output.actionLogPath` | `"sapience/action-log.md"` | Prose log of Act-tier items |
| `output.processedPassesPath` | `"sapience/processed-passes.json"` | Routed-pass tracking |
| `output.eventsPath` | `"sapience/events.jsonl"` | Shared suite event log |
| `output.dashboardPath` | `"sapience/dashboard.md"` | Auto-generated dashboard |
| `output.goalsPath` | `"goals/goals.json"` | Goals store (read for the dashboard's goals summary) |

## sapience-feedback

| Key | Default | Description |
|-----|---------|-------------|
| `logPath` | `"sapience/feedback.md"` | Feedback signal log |
| `calibrationPath` | `"sapience/calibration.json"` | Calibration profile to update (shared with sapience) |
| `eventsPath` | `"sapience/events.jsonl"` | Shared suite event log |
| `memoryEnabled` | `true` | Write meta-pointer reminders for corrections via `api.memory.add` |
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
| `output.goalsPath` | `"goals/goals.json"` | Goals store |
| `output.eventsPath` | `"sapience/events.jsonl"` | Shared suite event log |

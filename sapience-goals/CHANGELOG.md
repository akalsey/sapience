# @akalsey/sapience-goals

## 0.4.12

### Patch Changes

- ef987cd: Two fixes from watching a live proposal flood: a new `goal_list` tool lets the agent look up goal ids in later turns (every goals tool required an id the model had no way to retrieve — "I'm having trouble with the goal_select_approach tool"), and routing now injects at most `delivery.maxPerCycle` items per cycle (default 3, act-first then priority), queuing the overflow for the delivery cron to compose into one concise message instead of burying the user under eight boilerplate calibrate items in a single turn.

## 0.4.11

### Patch Changes

- c7ff04b: Goals are now temporary skills that build their own todo list. On approach selection the agent compiles standing instructions ("when you access PostHog, remember the results; compare against what you know; explain trends and outliers; don't force conclusions") and seeds todos via the new `goal_plan` tool, which installs the instructions as a real workspace skill (`skills/goal-<id>/SKILL.md`) active in every session. `goal_todo` grows and burns down the checklist; completing the last todo starts wrap-up — confirm the outcome, complete via `goal_update` (which retires the temporary skill), and only when the goal produced a recurring analysis worth keeping, optionally distill it into a permanent skill. Thinking passes see each active goal's open todos and propose work that moves them.

## 0.4.10

### Patch Changes

- b7b2d6a: `goal_submit`'s same-turn script now frames the goal as long-running — pursued by scheduled thinking passes across weeks — and explicitly forbids starting work in the submission turn: propose recurring approaches as options and wait for the user's pick, which is what steers the background iteration.

## 0.4.9

### Patch Changes

- 227e330: `goal_submit` now scripts the conversation users expect in the same turn: the tool result instructs the agent to acknowledge the goal, ask clarifying questions when the goal is ambiguous, and propose 2-3 concrete operational approaches (recording the choice via `goal_select_approach`) — instead of returning a bare id and injecting the approaches conversation into a later turn.

## 0.4.8

### Patch Changes

- 8c97fd0: Every injected prompt (tier proposals, heartbeat digests, goal decomposition/status) now opens by subordinating itself to the user's own message — injections prepend to the user's next turn, and a delivered proposal could hijack the turn entirely (a user submitting a goal got a response to a stale calibration item instead of their goal).

## 0.4.7

### Patch Changes

- c1ac2f6: Configurable delivery target: set `plugins.entries.<id>.config.delivery.sessionKey` to route proposal/digest/status injections into a specific session (e.g. the operator's DM conversation) instead of the agent main session. On multi-user installs with `session.dmScope: per-channel-peer`, the main session is machine-only — questions asked there await answers that can never arrive; delivering into the operator's own conversation puts proposals where replies actually land.

## 0.4.6

### Patch Changes

- 336d457: Declare every registered tool in each manifest's `contracts.tools` — openclaw rejects undeclared tools at registration ("plugin must declare contracts.tools for: <name>"), so `get_pending_deliveries`, `watch_metric`, `watch_remove`, `record_outcome`, and all five goal management tools have been silently absent from gateways since they shipped. A new manifest-contracts test in each package pins the manifest to the source so future tools can't ship undeclared.

## 0.4.5

### Patch Changes

- 7da8039: Delivery finally works: openclaw's plugin registration guard voids `enqueueNextTurnInjection` after `register()` completes (it is missing from the late-callable allowlist in `api-lifecycle.ts`), which is why no injection has ever been delivered. `scheduleSessionTurn` IS late-callable — when the guard eats an injection, delivery now schedules an immediate one-shot agent turn in the main session instead. sapience-goals also picks up the probe/diagnostic work its stale copy of main-session was missing.

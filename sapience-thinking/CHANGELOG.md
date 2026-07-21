# @akalsey/sapience-thinking

## 0.4.16

### Patch Changes

- c7ff04b: Goals are now temporary skills that build their own todo list. On approach selection the agent compiles standing instructions ("when you access PostHog, remember the results; compare against what you know; explain trends and outliers; don't force conclusions") and seeds todos via the new `goal_plan` tool, which installs the instructions as a real workspace skill (`skills/goal-<id>/SKILL.md`) active in every session. `goal_todo` grows and burns down the checklist; completing the last todo starts wrap-up — confirm the outcome, complete via `goal_update` (which retires the temporary skill), and only when the goal produced a recurring analysis worth keeping, optionally distill it into a permanent skill. Thinking passes see each active goal's open todos and propose work that moves them.

## 0.4.15

### Patch Changes

- 8c97fd0: Every injected prompt (tier proposals, heartbeat digests, goal decomposition/status) now opens by subordinating itself to the user's own message — injections prepend to the user's next turn, and a delivered proposal could hijack the turn entirely (a user submitting a goal got a response to a stale calibration item instead of their goal).

## 0.4.14

### Patch Changes

- c1ac2f6: Configurable delivery target: set `plugins.entries.<id>.config.delivery.sessionKey` to route proposal/digest/status injections into a specific session (e.g. the operator's DM conversation) instead of the agent main session. On multi-user installs with `session.dmScope: per-channel-peer`, the main session is machine-only — questions asked there await answers that can never arrive; delivering into the operator's own conversation puts proposals where replies actually land.

## 0.4.13

### Patch Changes

- 6c07e00: Bound the hypothesis ledger: live hypotheses expire after 14 days without a sighting, refuted ones drop after 7, and the ledger caps at 25 live cases (a production ledger reached 185, feeding every stale crisis-era suspicion into every thinking pass). Thinking passes now receive at most the 10 most recently seen open hypotheses.

## 0.4.12

### Patch Changes

- 336d457: Declare every registered tool in each manifest's `contracts.tools` — openclaw rejects undeclared tools at registration ("plugin must declare contracts.tools for: <name>"), so `get_pending_deliveries`, `watch_metric`, `watch_remove`, `record_outcome`, and all five goal management tools have been silently absent from gateways since they shipped. A new manifest-contracts test in each package pins the manifest to the source so future tools can't ship undeclared.

## 0.4.11

### Patch Changes

- 7da8039: Delivery finally works: openclaw's plugin registration guard voids `enqueueNextTurnInjection` after `register()` completes (it is missing from the late-callable allowlist in `api-lifecycle.ts`), which is why no injection has ever been delivered. `scheduleSessionTurn` IS late-callable — when the guard eats an injection, delivery now schedules an immediate one-shot agent turn in the main session instead. sapience-goals also picks up the probe/diagnostic work its stale copy of main-session was missing.

## 0.4.10

### Patch Changes

- f58c099: When both the facade and the flat injection API resolve `undefined`, the `delivery_failed` reason now also embeds the flat function's source (`flatFn=`) — every published openclaw build wires an object-returning implementation there, so its body identifies which unexpected implementation production is actually calling.

## 0.4.9

### Patch Changes

- b5e986f: Injection calls that resolve `undefined` (an unidentified wrapper between the plugin and the gateway) now retry on the flat `api.enqueueNextTurnInjection`, and when that can't settle it either, the `delivery_failed` reason embeds the facade function's source so the wrapper can be identified from the event log.

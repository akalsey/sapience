# @akalsey/sapience

## 0.5.0

### Minor Changes

- 5fbb039: Skill proposals: repeated multi-step tasks become tracked skill specs.

  sapience owns the feature (following the hypotheses pattern): a JSON ledger
  (`sapience/skill-proposals.json`) plus an append-only human-readable spec doc
  (`skill-proposals.md` at the workspace root). Three new tools —
  `skill_proposal` (create-or-append-evidence, deduped by normalized name),
  `skill_proposal_update` (status: proposed/building/installed/declined), and
  `skill_proposal_list`. New proposals notify the operator through the normal
  delivery path; open proposals resurface in the weekly digest; doctor knows the
  ledger file. Nothing is ever built or installed unbidden.

  sapience-thinking passes now watch recent activity for the same multi-step
  task done more than once and propose codifying it, and read the ledger into an
  "Open Skill Proposals" context section so they append evidence instead of
  re-proposing (absent ledger = standalone install, section omitted).

  sapience-goals' wrap-up now points skill crystallization at the
  `skill_proposal` tool when it is available, instead of free-text advice.

## 0.4.22

### Patch Changes

- d087829: Stop re-proposing findings the user already corrected.

  A one-time corrective directive was classified as method feedback and stored
  verbatim as a permanent analytical playbook; every thinking pass then re-read
  it as an unexecuted user mandate and re-proposed it — under a fresh uuid each
  time, so pass-id dedupe never caught it. Three layers of fix:

  - sapience-feedback: the classifier prompt now distinguishes standing rules
    from one-time directives (which are never "method"), and `addPlaybook`
    rejects text too long to be a single analytical move, emitting a
    `playbook_rejected` event.
  - sapience: routing now dedupes items by normalized text against a
    delivered-items ledger (`delivery.dedupeWindowHours`, default 72h);
    suppressed repeats emit `item_suppressed` events instead of re-delivering.
  - sapience-thinking: the playbooks prompt section frames playbooks as
    techniques, not tasks — never something to propose executing.

## 0.4.21

### Patch Changes

- ef987cd: Two fixes from watching a live proposal flood: a new `goal_list` tool lets the agent look up goal ids in later turns (every goals tool required an id the model had no way to retrieve — "I'm having trouble with the goal_select_approach tool"), and routing now injects at most `delivery.maxPerCycle` items per cycle (default 3, act-first then priority), queuing the overflow for the delivery cron to compose into one concise message instead of burying the user under eight boilerplate calibrate items in a single turn.

## 0.4.20

### Patch Changes

- 8c97fd0: Every injected prompt (tier proposals, heartbeat digests, goal decomposition/status) now opens by subordinating itself to the user's own message — injections prepend to the user's next turn, and a delivered proposal could hijack the turn entirely (a user submitting a goal got a response to a stale calibration item instead of their goal).

## 0.4.19

### Patch Changes

- 0457574: The doctor's missing-file warnings now say which activity creates each cold-start file (`action-log.md`: first act-tier execution, which needs calibration built from record_outcome feedback; `goals/goals.json`: first goal_submit) instead of a generic "may be normal", so healthy young installs stop reading as breakage.

## 0.4.18

### Patch Changes

- bab12d0: Doctor `--fix` now mirrors applied config writes onto the loaded config before re-reporting, so the post-fix report shows the fixed state instead of re-asserting the pre-fix warning; the delivery-target detail no longer tells you to run `--fix` while already running under it.

## 0.4.17

### Patch Changes

- 1895b06: Install and doctor now handle delivery routing end to end: install.sh detects when `session.dmScope` makes the main session machine-only, discovers the operator's recent conversations from the session store, and offers (or auto-confirms, when unambiguous) routing suite deliveries there — no chat ids to look up. The doctor gains a `delivery:target` check that warns "the suite doesn't know where to send deliveries," verifies a configured target still exists in the session store, and `--fix` routes all three delivering plugins to the most recent operator conversation.

## 0.4.16

### Patch Changes

- c1ac2f6: Configurable delivery target: set `plugins.entries.<id>.config.delivery.sessionKey` to route proposal/digest/status injections into a specific session (e.g. the operator's DM conversation) instead of the agent main session. On multi-user installs with `session.dmScope: per-channel-peer`, the main session is machine-only — questions asked there await answers that can never arrive; delivering into the operator's own conversation puts proposals where replies actually land.

## 0.4.15

### Patch Changes

- 6c07e00: Bound the hypothesis ledger: live hypotheses expire after 14 days without a sighting, refuted ones drop after 7, and the ledger caps at 25 live cases (a production ledger reached 185, feeding every stale crisis-era suspicion into every thinking pass). Thinking passes now receive at most the 10 most recently seen open hypotheses.

## 0.4.14

### Patch Changes

- 336d457: Declare every registered tool in each manifest's `contracts.tools` — openclaw rejects undeclared tools at registration ("plugin must declare contracts.tools for: <name>"), so `get_pending_deliveries`, `watch_metric`, `watch_remove`, `record_outcome`, and all five goal management tools have been silently absent from gateways since they shipped. A new manifest-contracts test in each package pins the manifest to the source so future tools can't ship undeclared.

## 0.4.13

### Patch Changes

- ed488e2: Doctor warns when a plugin's loaded version trails the installed build ("v0.4.11 loaded, v0.4.12 installed — restart the gateway"), catching the updated-but-not-reloaded state that previously surfaced only as confusing runtime errors like "no registered tools matched".

## 0.4.12

### Patch Changes

- 4c35755: New `sapience-delivery` cron: failed main-session injections (voided by openclaw's registration guard on stock installs) now queue durably in `sapience/pending-deliveries.json`, and a fourth cron with `--announce` delivery drains the queue every 15 minutes and speaks the pending items to the user's chat — the one channel path stock openclaw grants globally-installed plugins. The weekly digest hands off to the queue instead of retrying every pass. Re-run install.sh or `openclaw sapience doctor --fix` to register the cron.

## 0.4.11

### Patch Changes

- 7da8039: Delivery finally works: openclaw's plugin registration guard voids `enqueueNextTurnInjection` after `register()` completes (it is missing from the late-callable allowlist in `api-lifecycle.ts`), which is why no injection has ever been delivered. `scheduleSessionTurn` IS late-callable — when the guard eats an injection, delivery now schedules an immediate one-shot agent turn in the main session instead. sapience-goals also picks up the probe/diagnostic work its stale copy of main-session was missing.

## 0.4.10

### Patch Changes

- f58c099: When both the facade and the flat injection API resolve `undefined`, the `delivery_failed` reason now also embeds the flat function's source (`flatFn=`) — every published openclaw build wires an object-returning implementation there, so its body identifies which unexpected implementation production is actually calling.

## 0.4.9

### Patch Changes

- b5e986f: Injection calls that resolve `undefined` (an unidentified wrapper between the plugin and the gateway) now retry on the flat `api.enqueueNextTurnInjection`, and when that can't settle it either, the `delivery_failed` reason embeds the facade function's source so the wrapper can be identified from the event log.

# @akalsey/sapience-thinking

## 0.5.8

### Patch Changes

- 461ddd1: Put a ceiling on CALIBRATE volume, and stop the pass narrating its own struggles.

  2026-08-03: 28 proposals reached the user in a single day. Every one was
  learning tier, 27 were priority 5, and 24 were the agent describing its own
  failure to finish a task the user was sitting there watching it fail. Each
  15-minute pass re-described the same unresolved situation in new words, its
  theory of the failure evolving as it went — "the skill", then "use-browser",
  then "my inability to run the steps I myself propose". That is a running
  commentary on one situation, not a repeated sentence, so similarity matching
  cannot catch it: replaying the day through the containment dedup shipped in the
  previous release takes 28 down to 15, not to 1.

  **A daily ceiling on CALIBRATE, as a circuit breaker.** `delivery.maxCalibratePerDay`
  (default 3) bounds learning-tier notes per local day, whatever shape the next
  loop takes. It mirrors `push.maxPerDay`, which already bounds channel wake-ups
  the same way — and which correctly held at 6 that day while deliveries, having
  no ceiling at all, did not. Over-budget items are dropped rather than deferred:
  a runaway that queues today just arrives tomorrow, and calibration signal is
  fungible — the point is a few samples, not every instance. A
  `calibrate_budget_exhausted` event names what went. Actionable tiers are never
  capped, so an outage still gets through on a day the suite spent asking
  questions. Set it to 0 to turn CALIBRATE notes off, or a negative number for no
  ceiling.

  **The pass no longer reports its own in-flight failures.** If the transcripts
  show it failing, retrying, or being corrected on something the user asked for in
  that same conversation, the user can already see it; saying so once per pass
  turns their own request into a stream of notifications. Reporting on its own
  conduct is now reserved for patterns spanning different tasks over time.

  Also fixes `calibrateStatePath` being absent from `mergeConfig`'s path
  resolution, which left it relative to the working directory — the same class of
  bug that once wrote `sapience/sapience/pending-deliveries.json` into the repo.

## 0.5.7

### Patch Changes

- 674cc02: Stop the same finding reaching the user several times over.

  Three faults compounding, all confirmed against a production install.

  **Transcript listeners were accumulating.** Four `noticed` events for a single
  turn carried four distinct watcher ids and one pid: `register()` runs more than
  once per gateway process, and every run built a new `TurnWatcher` and subscribed
  it, discarding whatever the runtime handed back. One turn therefore ran one
  side-pass per accumulated listener — each an independent LLM call over the same
  transcript, so each worded the same remark differently, which is exactly the
  input text dedup cannot collapse. Over 27 days, 82% of noticing bursts fired
  more than once, up to nine times, and 490 of 519 incidental observations came
  from a multi-fire burst. `installTurnWatcher` now keeps one watcher per process,
  adopts a later registration's config rather than stacking another listener, and
  re-subscribes only when the runtime gives back a disposer.

  **Dedup missed restatements of an unresolved situation.** Jaccard falls as a
  description grows, because the added tokens land in the union — so the longer a
  pass talks about the same stuck thing, the less it looks like a repeat. Once
  passes could read session transcripts, an unfinished task got freshly
  re-observed every 15 minutes: "I remain in a critical failure loop, unable to
  answer the user's question about AI minutes" reached the user four times in 75
  minutes at priority 5, every pair scoring 0.243–0.556 against a 0.60 bar.
  Matching now also accepts containment (shared / smaller side) at 0.65 with an
  8-token floor, the same rule the hypothesis ledger already used — one notion of
  "the same finding again" across the suite.

  **Duplicates queued behind each other became repeats hours apart.** The pending
  queue releases one item per delivery-cron cycle, so twins never arrive together;
  they arrive as the same point made again later. Ageing entries out is not an
  option — a proposal may legitimately wait days for the user to come back to it —
  so a restatement of something already queued is no longer enqueued at all.
  Delivery records the raw finding alongside the prompt to make that comparison
  possible; the prompt itself is mostly shared tier boilerplate. Digests are
  exempt: periodic summaries overlapping in wording is normal.

  Fixes delivery test fixtures that spread one shared object, giving every item
  identical text — they were asserting overflow ordering with items the queue is
  now right to collapse.

## 0.5.6

### Patch Changes

- 03135fa: Retire queued deliveries once you've answered what they were about.

  Deliveries are capped per cycle and the overflow waits in a durable queue the
  delivery cron drains every 15 minutes. Nothing ever reconsidered that queue, so
  it behaved as a time-delay line: a burst of proposals written in one minute
  arrived over the following hours, with no regard for what the user said in
  between.

  Production, 2026-08-02: one pass produced an observation about a reasoning flaw
  and the action derived from it. The user gave explicit direction on the
  observation at 18:17. The sibling action was still queued and the cron delivered
  it at 18:30 as a fresh "would you like me to go ahead, or shall I check with you
  first?" about the subject just settled — 13 minutes after they settled it.

  `record_outcome` now retires queued deliveries the answer speaks for. Two ways
  an entry qualifies: it came from the same pass — one pass is one unit of
  reasoning, and its observation plus the action derived from that observation are
  facets of a single thought — or its text is near-identical to the answered one,
  which catches the case where the same remark was emitted under several pass ids.
  Entries with no outcome record are left alone, since absence isn't evidence of
  staleness. A `stale_deliveries_dropped` event names what went.

  Replayed against the production tracker, the same-pass rule is what does the
  work here: the two items score 0.196 on text similarity, far under the 0.6 bar.

  Removal applies to the queue as it is on disk at write time, not to the snapshot
  read a moment earlier. The file has three unsynchronized writers across two
  plugin processes and no shared lock, so writing back a stale snapshot could
  clobber a concurrent drain and put already-delivered items back in the queue —
  the same repeat, through a different door.

  Also adds a diagnostic for a related fault still under investigation: post-task
  noticing fires several times for a single turn (four in 604ms on 2026-08-02;
  82% of bursts over 27 days involved more than one fire, up to nine), each
  side-pass wording the same remark differently so text dedup can't collapse them.
  The cooldown is not the cause — it is correct within an instance — so each
  `TurnWatcher` now reports an `instanceId` and pid on every `noticed` event,
  which distinguishes accumulating listeners from multiple gateway processes. The
  four side-passes in that burst quote heavily overlapping evidence spans (one
  pair shares all three; six distinct spans across the whole burst), so they read
  the same transcript rather than successive slices of it — which is what several
  watchers holding identical buffers would produce, and not what one watcher
  firing repeatedly would, since it clears its buffer on every fire.

  Fixes two tests that passed for the wrong reason: the cooldown test fed a
  12-character turn to `minTurnChars: 500` and returned at the length gate without
  ever reaching the cooldown, and both it and the tiny-turn test used a session key
  that `isNoticeableSession` rejects outright.

## 0.5.5

### Patch Changes

- a39c1d0: Stop proposing skills the install already has.

  A thinking pass proposed building a skill that was already installed, and the
  ledger logged it and told the operator about it. Nothing in the suite had ever
  looked at the installed skills: `skill_proposal` deduped only against its own
  earlier entries, and a pass runs in an isolated cron session with no skill
  context at all — so "this task keeps repeating, make it a skill" had no way to
  notice that someone already did.

  Both ends now read the same inventory: `<workspace>/skills`, the state dir's
  `skills/`, and any roots listed in the new `skillsDirs` key (both plugins),
  parsed from each skill's `SKILL.md` frontmatter.

  - **sapience-thinking** renders an "Installed Skills — Already Built" section
    into the pass prompt, ahead of the open-proposals section, and the pass
    instruction now orders the two checks: if an installed skill does the job the
    finding is that it wasn't used, not that something needs building; if one
    nearly does, extend that skill by name.
  - **sapience** enforces it at the ledger's door, which is the one point every
    path goes through. A proposal naming an installed skill is refused outright.
    A proposal that overlaps one is refused once with the closest skills named,
    and goes through only when the caller re-calls with `not_covered_by` saying
    what the existing skill can't do — which is then recorded in the spec, so the
    human reading it sees the ruling. Refusals emit
    `skill_proposal_duplicate_blocked`.

## 0.5.4

### Patch Changes

- 82d25e6: Let thinking passes read conversation, and let corrections stick.

  Found while tracing why a pass kept re-escalating an outage the user had twice
  said wasn't real, and which the agent had itself verified was fine.

  **Passes were blind to every conversation.** `resolveContextDirs` joined
  `sessions` onto the agent _data_ dir, but transcripts live at
  `agents/<id>/sessions` — a sibling of `agents/<id>/agent/`, not a child. The
  agent id was wrong too: a real OpenClaw config has no `agent.id` key (it has
  `agents.defaults`), so the read was always undefined and the fallback decided;
  it said `default` while the live agent is `main`. The resolver now probes both
  layouts, verifies candidates against the disk, and falls back to scanning
  `agents/*/sessions`, so a wrong id self-corrects. `contextSessionsDirExists` is
  recorded in the status artifact — the path was already reported there, but
  nothing ever asserted it resolved, which is how this survived unnoticed.

  **A missing session directory no longer reads as a quiet day.** Both produced
  "No recent session activity found", so a green test suite and a healthy-looking
  artifact were consistent with reading nothing at all. The bundle now carries
  `sessionsDirMissing` and the pass prompt leads with an explicit blindness
  warning telling it not to infer that silence means a problem is unresolved.

  **Delivered notes no longer outrank the agent's own eyes.** They arrive as
  `[SAPIENCE: PROPOSE] A thinking pass identified this` with a confidence
  percentage and read as independent monitoring. In production the agent ran the
  auth flow, confirmed success with a `list_drive_items` call, told the user so —
  and twelve minutes later wrote "the cron job's message just now is definitive
  proof that the Google Authentication issue is not resolved", apologizing for
  having been right. Every delivery now carries its provenance: the pass saw
  neither the conversation nor any live check, it is a suggestion rather than
  confirmation, and first-hand evidence wins.

  **Corrections can reach the ledger.** `recordVerdict` had one caller — the
  internal investigation subagent — and no tool exposed it, so "you should have
  no active issues with google auth" had nowhere to land: the agent agreed, wrote
  it to memory, and all eight fragments stayed open for four more days. Adds
  `hypothesis_list` and `hypothesis_resolve`, which settles every case matching a
  short free-text description so one correction clears a whole cluster. Query
  matching is token-subset, not the dedup similarity metric — two-word queries
  fall below that metric's containment floor, which is exactly the phrasing
  people use.

## 0.5.3

### Patch Changes

- 5d7c9e3: Stop the hypothesis ledger from manufacturing corroboration for itself.

  One real Google auth failure fragmented into 8 open ledger entries, and every
  later thinking pass read that pile as 8 independent confirmations — grading
  observations `replicated` while citing the pass context itself as the evidence,
  and escalating to priority 5 over four days.

  - Near-duplicate matching adds a containment test above an 8-token floor, so a
    restatement that piles on detail merges instead of opening a new case (the two
    production scope hypotheses scored 0.528 Jaccard against a 0.6 threshold).
  - Un-corroborated hunches expire after 72h rather than 14 days, and an
    `inconclusive` verdict no longer counts as corroboration — every one in
    production reported the investigator could not reach the data at all.
    Corroboration now means a `supported`/`refuted` verdict or a re-sighting in a
    genuinely later pass, not fragments merged within a single burst.
  - The rendered ledger collapses restatements into one line carrying a count, so
    redundancy reads as redundancy. Grouping by `domain` would not have helped:
    23 of 25 production entries were `general`.
  - The pass prompt now forbids citing its own prior output as evidence of
    recurrence, and states that absence of new activity is not evidence a problem
    persists — passes had been escalating on runs of `nothing_to_report`.
  - The pass-history section gets framing of its own. Clearing the ledger in
    production did not stop the loop: the next pass escalated "for the fifth
    time", citing "chronology of repeated P5 proposals in the last four thinking
    passes". It was the only section rendered as a bare header with no
    instructions, and it now says plainly that a repeat is a record of what you
    said, not evidence for it.

## 0.5.2

### Patch Changes

- 51d9a8e: Two fixes to the CALIBRATE delivery pipeline, from 23 days of production evidence in which the calibration loop never promoted a single entry past `propose`.

  **Item ids are now generated host-side.** The thinking model was asked to emit a UUID per item and that id became the `proposal_id` the agent had to hand back to `record_outcome`. Models don't generate random UUIDs — they generate patterned ones and reuse them: across 1,217 passes, 92 ids repeated and 88 of those carried different content each time, and one id named three different pending actions inside a single delivered prompt, making the `record_outcome` call ambiguous by construction. The parser now mints a fresh v4 UUID per item and discards whatever the model emitted; the prompt no longer asks for one.

  **`delivery.maxPerCycle` is enforced per routing run, and the surviving items ship as one note.** The cap lived inside `deliverItems`, which routing calls once per _pass_, so it was really a per-pass cap: a run draining a backlog injected the cap times the backlog depth. Production saw one run log `passes=6 items=21` and put 15 separate notes — each with its own copy of the "the user's message takes priority" guard — ahead of the user's next message, and a 19-pass drain the morning after active hours resumed. Routing now collects every item from every pass it drained and delivers once, and the selected items share a single priority guard instead of repeating it per item. The default drops from 3 to 1; overflow queues for the `sapience-delivery` cron as before.

## 0.5.1

### Patch Changes

- 8f7e975: Stop thinking passes from re-surfacing problems that later evidence already resolved. The pass prompt now instructs the model to read recent activity and memory as one whole body of evidence across time and report the most recent state of a situation, so a point-in-time issue (e.g. "unable to access Google Sheets") that was subsequently fixed is no longer flagged as a live observation.

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

## 0.4.17

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

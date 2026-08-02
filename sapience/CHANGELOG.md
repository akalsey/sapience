# @akalsey/sapience

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

- 8dd0f22: Delivery notes no longer sound like a form letter. Tier prompts scripted exact
  sentences ("My instinct is to… Is that the right level of initiative…") and
  the model repeated them verbatim on every note. Prompts now describe what to
  convey — for calibrate: what was noticed, what the agent would do if trusted,
  and whether to act or check in next time — and a shared instruction tells the
  model to write in its own words, matched to the conversation's tone, varying
  phrasing between notes.

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

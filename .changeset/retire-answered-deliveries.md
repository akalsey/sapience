---
"@akalsey/sapience-thinking": patch
---

Retire queued deliveries once you've answered what they were about.

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

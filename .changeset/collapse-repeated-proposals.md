---
"@akalsey/sapience": patch
"@akalsey/sapience-thinking": patch
---

Stop the same finding reaching the user several times over.

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

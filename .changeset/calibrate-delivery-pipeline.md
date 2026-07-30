---
"@akalsey/sapience-thinking": patch
"@akalsey/sapience": patch
---

Two fixes to the CALIBRATE delivery pipeline, from 23 days of production evidence in which the calibration loop never promoted a single entry past `propose`.

**Item ids are now generated host-side.** The thinking model was asked to emit a UUID per item and that id became the `proposal_id` the agent had to hand back to `record_outcome`. Models don't generate random UUIDs — they generate patterned ones and reuse them: across 1,217 passes, 92 ids repeated and 88 of those carried different content each time, and one id named three different pending actions inside a single delivered prompt, making the `record_outcome` call ambiguous by construction. The parser now mints a fresh v4 UUID per item and discards whatever the model emitted; the prompt no longer asks for one.

**`delivery.maxPerCycle` is enforced per routing run, and the surviving items ship as one note.** The cap lived inside `deliverItems`, which routing calls once per *pass*, so it was really a per-pass cap: a run draining a backlog injected the cap times the backlog depth. Production saw one run log `passes=6 items=21` and put 15 separate notes — each with its own copy of the "the user's message takes priority" guard — ahead of the user's next message, and a 19-pass drain the morning after active hours resumed. Routing now collects every item from every pass it drained and delivers once, and the selected items share a single priority guard instead of repeating it per item. The default drops from 3 to 1; overflow queues for the `sapience-delivery` cron as before.

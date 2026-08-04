---
"@akalsey/sapience": patch
"@akalsey/sapience-thinking": patch
---

Put a ceiling on CALIBRATE volume, and stop the pass narrating its own struggles.

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

---
"@akalsey/sapience": patch
"@akalsey/sapience-thinking": patch
---

Stop the hypothesis ledger from manufacturing corroboration for itself.

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

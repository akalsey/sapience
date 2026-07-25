---
"@akalsey/sapience": patch
"@akalsey/sapience-thinking": patch
"@akalsey/sapience-feedback": patch
---

Stop re-proposing findings the user already corrected.

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

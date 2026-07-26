---
"@akalsey/sapience": minor
"@akalsey/sapience-thinking": minor
"@akalsey/sapience-goals": patch
---

Skill proposals: repeated multi-step tasks become tracked skill specs.

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

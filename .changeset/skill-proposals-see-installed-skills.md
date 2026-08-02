---
"@akalsey/sapience": patch
"@akalsey/sapience-thinking": patch
---

Stop proposing skills the install already has.

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

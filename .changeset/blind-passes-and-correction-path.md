---
"@akalsey/sapience": patch
"@akalsey/sapience-thinking": patch
---

Let thinking passes read conversation, and let corrections stick.

Found while tracing why a pass kept re-escalating an outage the user had twice
said wasn't real, and which the agent had itself verified was fine.

**Passes were blind to every conversation.** `resolveContextDirs` joined
`sessions` onto the agent *data* dir, but transcripts live at
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

---
"@akalsey/sapience": patch
"@akalsey/sapience-thinking": patch
"@akalsey/sapience-goals": patch
---

Every injected prompt (tier proposals, heartbeat digests, goal decomposition/status) now opens by subordinating itself to the user's own message — injections prepend to the user's next turn, and a delivered proposal could hijack the turn entirely (a user submitting a goal got a response to a stale calibration item instead of their goal).

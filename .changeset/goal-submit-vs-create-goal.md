---
"@akalsey/sapience-goals": patch
---

Disambiguate `goal_submit` from core's `create_goal`. Agents were reaching for OpenClaw's `create_goal` — a per-thread token-budget tracker that expires with the session — when the user asked for a goal that survives sessions. The tool description, SKILL.md, and README now say plainly which family is which.

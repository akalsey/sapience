---
"@akalsey/sapience-goals": patch
---

`goal_submit` now scripts the conversation users expect in the same turn: the tool result instructs the agent to acknowledge the goal, ask clarifying questions when the goal is ambiguous, and propose 2-3 concrete operational approaches (recording the choice via `goal_select_approach`) — instead of returning a bare id and injecting the approaches conversation into a later turn.

---
"@akalsey/sapience": patch
---

The doctor's missing-file warnings now say which activity creates each cold-start file (`action-log.md`: first act-tier execution, which needs calibration built from record_outcome feedback; `goals/goals.json`: first goal_submit) instead of a generic "may be normal", so healthy young installs stop reading as breakage.

---
"@akalsey/sapience": patch
---

Doctor warns when a plugin's loaded version trails the installed build ("v0.4.11 loaded, v0.4.12 installed — restart the gateway"), catching the updated-but-not-reloaded state that previously surfaced only as confusing runtime errors like "no registered tools matched".

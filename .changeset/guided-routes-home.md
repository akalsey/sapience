---
"@akalsey/sapience": patch
---

Install and doctor now handle delivery routing end to end: install.sh detects when `session.dmScope` makes the main session machine-only, discovers the operator's recent conversations from the session store, and offers (or auto-confirms, when unambiguous) routing suite deliveries there — no chat ids to look up. The doctor gains a `delivery:target` check that warns "the suite doesn't know where to send deliveries," verifies a configured target still exists in the session store, and `--fix` routes all three delivering plugins to the most recent operator conversation.

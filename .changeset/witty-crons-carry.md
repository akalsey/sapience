---
"@akalsey/sapience": patch
---

New `sapience-delivery` cron: failed main-session injections (voided by openclaw's registration guard on stock installs) now queue durably in `sapience/pending-deliveries.json`, and a fourth cron with `--announce` delivery drains the queue every 15 minutes and speaks the pending items to the user's chat — the one channel path stock openclaw grants globally-installed plugins. The weekly digest hands off to the queue instead of retrying every pass. Re-run install.sh or `openclaw sapience doctor --fix` to register the cron.

---
"@akalsey/sapience": patch
---

Doctor `--fix` now mirrors applied config writes onto the loaded config before re-reporting, so the post-fix report shows the fixed state instead of re-asserting the pre-fix warning; the delivery-target detail no longer tells you to run `--fix` while already running under it.

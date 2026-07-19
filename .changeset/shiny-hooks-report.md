---
"@akalsey/sapience": patch
"@akalsey/sapience-thinking": patch
---

When both the facade and the flat injection API resolve `undefined`, the `delivery_failed` reason now also embeds the flat function's source (`flatFn=`) — every published openclaw build wires an object-returning implementation there, so its body identifies which unexpected implementation production is actually calling.

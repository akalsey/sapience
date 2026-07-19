# @akalsey/sapience-thinking

## 0.4.11

### Patch Changes

- 7da8039: Delivery finally works: openclaw's plugin registration guard voids `enqueueNextTurnInjection` after `register()` completes (it is missing from the late-callable allowlist in `api-lifecycle.ts`), which is why no injection has ever been delivered. `scheduleSessionTurn` IS late-callable — when the guard eats an injection, delivery now schedules an immediate one-shot agent turn in the main session instead. sapience-goals also picks up the probe/diagnostic work its stale copy of main-session was missing.

## 0.4.10

### Patch Changes

- f58c099: When both the facade and the flat injection API resolve `undefined`, the `delivery_failed` reason now also embeds the flat function's source (`flatFn=`) — every published openclaw build wires an object-returning implementation there, so its body identifies which unexpected implementation production is actually calling.

## 0.4.9

### Patch Changes

- b5e986f: Injection calls that resolve `undefined` (an unidentified wrapper between the plugin and the gateway) now retry on the flat `api.enqueueNextTurnInjection`, and when that can't settle it either, the `delivery_failed` reason embeds the facade function's source so the wrapper can be identified from the event log.

# @akalsey/sapience-feedback

## 0.5.5

### Patch Changes

- Survive OpenClaw's "cli-metadata" registration, which was failing every plugin in the suite.

  The gateway calls `register()` in contexts where the runtime deliberately does not exist, and reading `api.runtime` there does not return undefined — it throws:

  ```
  Plugin "sapience" runtime is intentionally unavailable during "cli-metadata"
  registration. Declare root commands in the manifest's cliCommands or defer
  runtime access out of register().
  ```

  The suite already wrapped its one register-time runtime read in a try/catch, but the catch then asked `if (api?.runtime?.agent)` to tell a real fault from the expected bail. Optional chaining on `api` does nothing about a getter on `.runtime` that throws, so the second read threw again from inside the catch, escaped `register()`, and the gateway failed the whole plugin — taking `openclaw sapience doctor` with it, the command an operator would reach for to diagnose exactly this.

  Runtime reads now go through a `readRuntime` helper that contains the throw and reports availability, so the failure path never touches `api.runtime` again. It still distinguishes a runtime that existed but failed to resolve a workspace (recorded as an init error, the silent death that once left a plugin reporting "vunknown" for nine days) from an absent one (quiet).

  `sapience` also now declares its root command in the manifest's `cliCommands`. Without it, an external plugin falls into openclaw's legacy path (`src/plugins/cli-root-descriptors.ts`) and the host loads the plugin runtime purely to collect CLI registrars — which is the registration that throws. Declaring it means the host never executes plugin code to learn the CLI surface. A manifest test pins the declaration to the command the registrar actually adds.

## 0.5.4

### Patch Changes

- Declare OpenClaw 2026.7.1 as the supported host floor (`openclaw.install.minHostVersion`, `openclaw.compat.pluginApi`, `peerDependencies.openclaw`), so an older gateway skips the plugin at load with a warning rather than half-running it.

  `openclaw sapience doctor` gains a HOST section reporting the detected version, erroring below the floor and noting when the host runs the strict silence contract introduced at 2026.8.1 — where the only quiet path for a job with a delivery route is a reply of the bare `NO_REPLY` token. On such hosts it also flags any suite job still carrying a live announce route. The CRONS section now understands command payloads (no tool grant to check) and treats the intentionally disabled delivery job as healthy, and it lists non-suite jobs whose stored tool policy carries suite tool names so that can be confirmed rather than assumed.

- Resolve the agent id from the roster OpenClaw actually ships.

  All four plugins read `config.agent.id`, a key no OpenClaw config has — the roster lives under `agents.entries`, a keyed object on a real install — so the read always missed and a hardcoded fallback decided instead: `"default"` in three plugins and `"main"` in the fourth. Three status artifacts therefore reported an agent id that did not exist, and generated audit jobs stored `agentId: "default"`, failing every run with `cron job agent is unavailable: default` on any install whose agent is named otherwise.

  A shared `resolveAgentId` now reads `agents.entries` (object or array form), honoring an entry flagged `default`. Generated audit jobs omit `--agent` entirely unless the roster really has a name, letting the scheduler resolve the configured default. `resolveMainSessionKey` used the same broken read and is fixed with it.

## 0.5.3

### Patch Changes

- d087829: Stop re-proposing findings the user already corrected.

  A one-time corrective directive was classified as method feedback and stored
  verbatim as a permanent analytical playbook; every thinking pass then re-read
  it as an unexecuted user mandate and re-proposed it — under a fresh uuid each
  time, so pass-id dedupe never caught it. Three layers of fix:

  - sapience-feedback: the classifier prompt now distinguishes standing rules
    from one-time directives (which are never "method"), and `addPlaybook`
    rejects text too long to be a single analytical move, emitting a
    `playbook_rejected` event.
  - sapience: routing now dedupes items by normalized text against a
    delivered-items ledger (`delivery.dedupeWindowHours`, default 72h);
    suppressed repeats emit `item_suppressed` events instead of re-delivering.
  - sapience-thinking: the playbooks prompt section frames playbooks as
    techniques, not tasks — never something to propose executing.

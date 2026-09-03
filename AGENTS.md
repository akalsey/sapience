# AGENTS.md

Shared instructions for all AI coding agents (Claude Code, Cursor, Copilot, Gemini, etc.).

---

## What This Project Is

**sapience-suite** is a monorepo of OpenClaw plugins that turn OpenClaw from a reactive assistant into a proactive agent with calibrated autonomy.

| Plugin | Status | Does |
|--------|--------|------|
| `sapience-thinking/` | Implemented | Periodic thinking passes; generates observations and proposals; writes `proposals.jsonl` sidecar |
| `sapience/` | Implemented | Routes proposals through autonomy tiers (Act/Propose/Ask/Explore/Learning); calibration profile; weekly digest; skill-proposal ledger (`skill_proposal` tools) |
| `sapience-feedback/` | Implemented | Captures corrections and confirmations from chat; updates calibration profile; writes meta-pointers via `api.memory.add` |
| `sapience-goals/` | Implemented | Accepts fuzzy long-running goals; plans them in-conversation; compiles the chosen approach into a temporary workspace skill with a self-maintained todo list; tracks progress; weekly status |

Ownership convention: **sapience owns action artifacts** (hypotheses ledger, skill-proposals ledger, delivery); **thinking only observes** — it reads sapience's files for pass context, tolerates their absence, and works standalone. Other plugins reference sapience tools loosely ("if a skill_proposal tool is available…"), never as hard dependencies.

---

## Repository Layout

```
sapience-suite/
├── AGENTS.md                  ← this file
├── CLAUDE.md                  ← Claude Code pointer to this file
├── README.md                  ← the suite's front door
├── install.sh                 ← interactive installer: plugins, 5 crons, delivery target, memory config
├── .gitignore
├── .changeset/                ← pending changesets (see Versioning)
├── docs/                      ← end-user documentation (in git)
├── internal-docs/             ← design docs, specs, plans — NOT in git
├── scripts/                   ← repo tooling (sync-plugin-versions.mjs)
├── sapience-thinking/         ← proactive thinking plugin
├── sapience/                  ← autonomy routing plugin + `openclaw sapience doctor`
├── sapience-feedback/         ← feedback calibration plugin
└── sapience-goals/            ← goal tracking plugin
```

`docs/` holds the user-facing guides: `configuration.md`, `cron-setup.md`, `troubleshooting.md`, `observability.md`, `memory-configuration.md`, `openclaw-memory-setup.md`, `uninstall.md`. Keep them in sync with the code in the same change that alters behavior — config keys, cron jobs, event types, and output files are all documented there.

Design specs and plans go in `internal-docs/` (gitignored), including anything a skill or workflow generates — `internal-docs/superpowers/specs/`, `internal-docs/superpowers/plans/`. Tools that default to writing under `docs/` must be redirected: specs committed to `docs/` have had to be moved and purged from history once already.

Each plugin is a standalone npm package with its own `package.json`, `tsconfig.json`, `vitest.config.ts`, and `src/` directory. npm package names match plugin IDs: `@akalsey/sapience-thinking`, `@akalsey/sapience`, `@akalsey/sapience-feedback`, `@akalsey/sapience-goals`.

---

## Development Conventions

**Language:** TypeScript ESM with `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`. All imports must use `.js` extensions (even for `.ts` source files).

**Testing:** Vitest. TDD throughout — write failing tests first, verify they fail, implement, verify they pass.

**Commits:** Small and frequent. One logical change per commit.

**Versioning:** Monorepo with independent per-plugin versioning via [changesets](https://github.com/changesets/changesets) (npm workspaces at the root). Only packages that actually changed get bumped. Do not hand-edit version fields.

Release workflow:

1. After landing a change, run `npx changeset` at the root — pick the affected package(s), a bump level (almost always `patch`), and write a one-line summary. Commit the generated `.changeset/*.md` with (or right after) the change.
2. To cut a release: `npm run version` — applies pending changesets to each `package.json`, writes `CHANGELOG.md` entries, and syncs `openclaw.plugin.json` versions (scripts/sync-plugin-versions.mjs). Commit the result as `chore: version packages`.
3. `npm run release` — builds (each package's `prepublishOnly`) and publishes only the packages whose versions aren't already on the registry. Then `git push --follow-tags`.

---

## Plugin Structure Conventions

Every plugin follows this pattern:

```
sapience-<name>/
├── package.json           — "type": "module", dependencies, scripts (test, typecheck)
├── openclaw.plugin.json   — id, name, description, version, activation
├── tsconfig.json          — NodeNext, strict: true
├── vitest.config.ts       — node environment, src/**/*.test.ts
├── index.ts               — re-exports default from ./src/service.js
└── src/
    ├── types.ts           — all interfaces and DEFAULT_CONFIG
    ├── utils.ts           — shared helpers
    ├── service.ts         — plugin entry point (definePluginEntry)
    └── *.test.ts          — tests colocated with source
```

The plugin entry is always `src/service.ts`, exported via `index.ts`.

---

## Host Compatibility

The suite supports **OpenClaw 2026.7.1 and newer**. That floor is declared in every plugin's `package.json` as `openclaw.install.minHostVersion` (plus `openclaw.compat.pluginApi` and `peerDependencies.openclaw`), and OpenClaw skips a plugin whose floor the host doesn't meet. `sapience/src/doctor/host-version.ts` holds the same constants for the doctor's HOST section; change both together.

There is no version-conditional code. `--declaration-key`, `--light-context` and command payloads all exist in both the 2026.07 and 2026.08 lines — verified against the published 2026.7.1 tarball, not assumed. What changed at **2026.8.1** is how a scheduled job stays quiet:

- The heartbeat-ack filter (`isHeartbeatOnlyResponse`, `resolveHeartbeatAckMaxChars`) is gone; only `NO_REPLY` is recognized.
- Suppression is strict about form — a bare token is silent, `Nothing pending. NO_REPLY` delivers "Nothing pending."
- An empty post-tool turn is no longer silent: the runner substitutes placeholder text, which a delivery route then delivers.

The design rule that follows: **never let a scheduled job depend on a model choosing silence.** Gate the run in plugin code, or give the job no delivery route the runner can fall back to. The delivery pair is the worked example — `sapience-poll-delivery` (command payload, no model) reads the queue and starts `sapience-delivery` (registered disabled) only when there is something to send.

The host mechanism, verified in source rather than inferred, decides which job configurations are safe:

```ts
// src/cron/delivery-plan.ts
requested: resolvedMode === "announce",
// src/cron/isolated-agent/run-executor.ts
terminalReplyExpectation: params.deliveryRequested === true && params.resolvedDeliveryOk ? "required" : "optional",
```

`--announce` makes visible terminal text *required*, so an empty turn gets placeholder text synthesized. `--no-deliver` sets `requested: false` even with `--channel`/`--to` present, dropping the expectation to `optional` while still resolving a route for the `message` tool. That is why a pinned delivery target is the silent configuration and announce is not.

Two corollaries worth not relitigating: **a better model does not fix an empty turn** (tested — `gemini-2.5-pro` still produced the placeholder; the substitution happens precisely when the model produces nothing), and **upgrading the host is not on its own a fix** (later 2026.8.1 builds dropped `SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT` and treat a `completed-empty` run as silent, but only where a visible terminal reply is not required — which still excludes announce jobs).

Related conventions:

- **Every registered cron carries `--declaration-key sapience:<name>`**, qualified `:<agent>` on multi-agent installs. Registration is an upsert; re-running the installer converges rather than duplicating. Never go back to delete-then-re-add.
- **Never store a guessed agent id.** Omit `--agent` and let the scheduler resolve the configured default. `resolveRegistrableAgentId` returns `undefined` rather than a guess for exactly this. A job created with an id the install lacks fails every run forever.
- **`config.agent.id` does not exist.** The roster is `agents.entries`, a keyed object on a real install. Use `resolve-agent.ts` (duplicated into each plugin, like `main-session.ts`).
- **Command-payload jobs must never write to stderr.** Cron derives a command job's delivered text from its output, and non-empty stdout *and* stderr are delivered together as a combined block. Diagnostics go to `events.jsonl`.
- Command payloads are preferred over `--trigger-script`: trigger scripts require `cron.triggers.enabled`, which grants headless `exec` with the owning agent's full tool policy.

`install.sh` (bash) and `sapience/src/doctor/cron-args.ts` (TypeScript) build the same `cron add` invocations and must change in lockstep; `cron-args.test.ts` asserts the shapes both depend on.

## Critical Rules

1. **All plugins live inside `sapience-suite/` as subdirectories.** Never create a plugin as a standalone directory at `~/projects/<plugin-name>/`.

2. **Import paths use `.js` extensions** even though source files are `.ts`. This is required by NodeNext module resolution.

3. **No `any` without justification.** Use proper types. When casting OpenClaw SDK types (which aren't in scope), a single `api: any` at the entry point is acceptable.

4. **Tests must not mock the filesystem for unit tests that can use tmpdir.** Use real temp directories (`mkdtemp`) for storage tests.

5. /docs is for end-user documentation only. Design docs and things Claude or the plugin maintainers need go into /internal-docs 

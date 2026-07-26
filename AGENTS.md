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
| `sapience-goals/` | Implemented | Accepts fuzzy long-running goals; decomposes them; tracks progress; weekly status |

Ownership convention: **sapience owns action artifacts** (hypotheses ledger, skill-proposals ledger, delivery); **thinking only observes** — it reads sapience's files for pass context, tolerates their absence, and works standalone. Other plugins reference sapience tools loosely ("if a skill_proposal tool is available…"), never as hard dependencies.

---

## Repository Layout

```
sapience-suite/
├── AGENTS.md                  ← this file
├── CLAUDE.md                  ← Claude Code pointer to this file
├── .gitignore
├── internal-docs/             ← design docs, specs, plans — NOT in git
├── sapience-thinking/         ← proactive thinking plugin
├── sapience/                  ← autonomy routing plugin
├── sapience-feedback/         ← feedback calibration plugin
└── sapience-goals/            ← goal tracking plugin
```

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

## Critical Rules

1. **All plugins live inside `sapience-suite/` as subdirectories.** Never create a plugin as a standalone directory at `~/projects/<plugin-name>/`.

2. **Import paths use `.js` extensions** even though source files are `.ts`. This is required by NodeNext module resolution.

3. **No `any` without justification.** Use proper types. When casting OpenClaw SDK types (which aren't in scope), a single `api: any` at the entry point is acceptable.

4. **Tests must not mock the filesystem for unit tests that can use tmpdir.** Use real temp directories (`mkdtemp`) for storage tests.

5. /docs is for end-user documentation only. Design docs and things Claude or the plugin maintainers need go into /internal-docs 

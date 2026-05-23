# AGENTS.md

Shared instructions for all AI coding agents (Claude Code, Cursor, Copilot, Gemini, etc.).

---

## What This Project Is

**sapience-suite** is a monorepo of OpenClaw plugins that turn OpenClaw from a reactive assistant into a proactive agent with calibrated autonomy.

| Plugin | Status | Does |
|--------|--------|------|
| `sapience-thinking/` | Implemented | Periodic thinking passes; generates observations and proposals; writes `proposals.jsonl` sidecar |
| `sapience/` | Implemented | Routes proposals through autonomy tiers (Act/Propose/Ask/Explore/Learning); calibration profile; weekly digest |
| `sapience-feedback/` | Implemented | Captures corrections and confirmations from chat; updates calibration profile; writes meta-pointers via `api.memory.add` |
| `sapience-goals/` | Implemented | Accepts fuzzy long-running goals; decomposes them; tracks progress; weekly status |

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

**Versioning:** Monorepo with independent per-plugin versioning. Use `changesets` when setting up release tooling — only bump packages that actually changed.

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


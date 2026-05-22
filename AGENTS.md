# AGENTS.md

Shared instructions for all AI coding agents (Claude Code, Cursor, Copilot, Gemini, etc.).

---

## What This Project Is

**sapience-suite** is a monorepo of OpenClaw plugins that turn OpenClaw from a reactive assistant into a proactive agent with calibrated autonomy.

| Plugin | Status | Does |
|--------|--------|------|
| `openclaw-thinking/` | Implemented | Periodic thinking passes; generates observations and proposals; writes `proposals.jsonl` sidecar |
| `openclaw-sapience/` | Implemented | Routes proposals through autonomy tiers (Act/Propose/Ask/Explore/Learning); calibration profile; weekly digest |
| `openclaw-feedback/` | Implemented | Captures corrections and confirmations from chat; updates calibration profile |
| `openclaw-goals/` | Implemented | Accepts fuzzy long-running goals; decomposes them; tracks progress; weekly status |
| `openclaw-memory/` | In progress | Per-turn-lean memory: small always-loaded core + on-demand BM25 search over indexed markdown files |

---

## Repository Layout

```
sapience-suite/
├── AGENTS.md                  ← this file
├── CLAUDE.md                  ← Claude Code pointer to this file
├── .gitignore
├── internal-docs/             ← design docs, specs, plans — NOT in git
├── openclaw-thinking/         ← proactive thinking plugin
├── openclaw-sapience/         ← autonomy routing plugin
├── openclaw-feedback/         ← feedback calibration plugin
├── openclaw-goals/            ← goal tracking plugin
└── openclaw-memory/           ← memory plugin (in progress)
```

Each plugin is a standalone npm package with its own `package.json`, `tsconfig.json`, `vitest.config.ts`, and `src/` directory.

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
openclaw-<name>/
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

---

## openclaw-memory Status

Currently implementing. Tasks complete:
- [x] Task 1: Project scaffold
- [x] Task 2: Types and utils (`src/types.ts`, `src/utils.ts`)
- [x] Task 3: Entry parser (`src/entry-parser.ts` — gray-matter wrapper)
- [x] Task 4: Storage (`src/storage.ts` — file I/O, uses `MEMORY_FILENAME_PATTERN`)
- [x] Task 5: BM25 (`src/bm25.ts` — hand-rolled, k1=1.5, b=0.75)
- [x] Task 6: Search (`src/search.ts` — tag filter, recency boost, access boost, excerpt)
- [ ] Task 7: Index Store (`src/index-store.ts`)
- [ ] Task 8: Stats and search log (`src/stats.ts`)
- [ ] Task 9: Service — plugin entry, 6 tools, chokidar watcher
- [ ] Task 10: SKILL.md and README

Implementation plan: `internal-docs/superpowers/plans/2026-05-21-memory.md`

Key design decisions already made:
- `generateId()` uses 8 hex chars (4 bytes entropy) — format `mem_YYYY-MM-DD_XXXXXXXX`
- `MEMORY_FILENAME_PATTERN` enforces `YYYY-MM-DD-slug-XXXXXXXX.md` format at I/O boundary
- BM25 corpus text boosts title and tags by repeating them twice
- `listEntryFilenames` filters by `MEMORY_FILENAME_PATTERN`, not just `.md` extension

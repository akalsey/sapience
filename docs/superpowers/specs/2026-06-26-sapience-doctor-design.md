# Sapience Doctor — Design

**Date:** 2026-06-26
**Status:** Approved, in implementation

## Goal

Add `openclaw sapience doctor`, a suite-wide diagnostic that reports cron health,
the **actual** resolved observability paths, file presence, and memory-wiki
configuration — surfacing the classes of problem we hit manually (the
`~/.openclaw/workspace/` path mismatch, the cron `payload.model` allowlist
rejection, and plugins silently failing to initialize). `--fix` applies the safe,
idempotent subset.

This is the tool that would have diagnosed each of those issues in seconds.

## Command surface

- `openclaw sapience doctor` — report (exit 0 = ok, non-zero if any `error` finding).
- `openclaw sapience doctor --fix` — apply auto-fixable findings, then report.
- `openclaw sapience doctor --json` — machine-readable report.

Honors openclaw's global `--profile` / `--dev` flags so its config and state-dir
resolution match the gateway when invoked the same way. This is the primary guard
against env/profile divergence.

## Ownership

The **`sapience`** plugin owns the command and produces the whole-suite report.
The other three plugins contribute only a status artifact (below); they get no CLI
code.

- Manifest: add `"commandAliases": [{ "name": "sapience" }]`.
- `register()`: `api.registerCli(({ program }) => { program.command("doctor")… }, { descriptors: [{ name: "sapience", description: "Diagnose the sapience suite", hasSubcommands: true }] })`.

## Data sources (hybrid, per-value priority)

Never hand-assemble paths. Prefer recorded runtime truth over recomputation.

1. **Plugin status artifact (authoritative).** Each suite plugin writes
   `<stateDir>/sapience/status/<pluginId>.json` at init:
   ```json
   { "pluginId": "sapience-thinking", "version": "0.2.3", "agentId": "main",
     "resolvedWorkspaceDir": "/abs/...", "outputPaths": { "logPath": "/abs/...", … },
     "initAt": "2026-06-26T..." }
   ```
   This is exactly what the plugin instance resolved in the gateway's real
   environment. A **missing** artifact ⇒ `error` finding "plugin not initialized"
   (catches `register()` bailing on its try/catch guard).
2. **Filesystem evidence (ground truth).** Existence + mtime of each expected file.
3. **SDK resolver (labeled fallback).** `resolveAgentWorkspaceDir(config, agentId)`
   only when no artifact exists, and to compute the "expected" value for mismatch
   detection. Always labeled as `expected (gateway not observed)`.

- **Cron data:** `CronServiceContract.list({ includeDisabled: true })` via
  `api.runtime.cron` when present; else fall back to spawning
  `openclaw cron list --json`; else degrade with a `warn`. Injected behind a
  `listCrons()` adapter.
- **Memory + plugin-install state:** from `OpenClawConfig`
  (`plugins.memory-wiki.*`, `plugins.memory-core.dreaming.enabled`, plugin entries).

## Report schema (pure core)

```ts
DoctorReport  { sections: Section[]; summary: { ok: number; warn: number; error: number }; exitCode: number }
Section       { title: string; findings: Finding[] }
Finding       { id: string; severity: "ok"|"warn"|"error"; message: string;
                detail?: string; source?: "artifact"|"fs"|"resolver"|"config"|"cron";
                fix?: FixDescriptor }
FixDescriptor { autofixable: boolean; description: string;
                kind: "config-set"|"cron-register"; payload?: unknown }
```

## Checks by section

- **PLUGINS** — for each of the 4: installed? version? status artifact present &
  recent? (missing ⇒ `error`: not loaded).
- **CRONS** — expected jobs present & enabled? `lastStatus` / `consecutiveErrors`?
  `payload.model` pinned **and not** in `agents.defaults.models` (the allowlist
  trap) ⇒ `error` with a fix hint.
- **PATHS** — resolved workspace dir (with source label); per output file: absolute
  path, exists?, mtime; **mismatch flag** when artifact vs resolver vs filesystem
  disagree (surfaces the `workspace/` bug).
- **MEMORY** — memory-wiki installed? `dreaming.enabled`, `vaultMode=bridge`,
  `bridge.enabled`, `search.corpus=all`? Each carries a `config-set` fix descriptor.

## `--fix` scope

Only safe, idempotent actions:
- the four **memory config sets**, and
- **registering missing crons** (reuses install.sh's add params; never deletes or
  recreates existing jobs).

Everything else reports a manual remediation hint. `--fix` prints exactly what it
changed.

## Code layout (`sapience/src/`)

- `doctor/types.ts` — schema.
- `doctor/report.ts` — **pure** `buildSuiteDoctorReport(ctx)`; all I/O injected.
- `doctor/sources.ts` — impure adapters (artifact / fs / resolver / cron / memory).
- `doctor/render.ts` — terminal + `--json` renderers.
- `doctor/fix.ts` — applies auto-fixable findings.
- `doctor/cli.ts` — `registerCli` wiring.
- `status-artifact.ts` — small `writeStatusArtifact()` helper; **duplicated** (~15
  lines) into each of the 4 plugins and called in `register()`. The JSON shape here
  is the contract. (Duplication chosen over an inter-package dep — KISS.)
- `service.ts` — write artifact at init + register CLI. Manifest — add alias.

## Testing

TDD. Unit-test `buildSuiteDoctorReport` with fixture configs/dirs (every
finding/severity path). Snapshot the terminal renderer. Dry-run the `--fix` mapping.

## Out of scope (v1)

- In-session agent tool / `sapience.doctor` gateway method (future).
- Fixing the underlying one-arg `resolveAgentWorkspaceDir(api.pluginConfig)`
  mis-call (companion change — the doctor *flags* it via the PATHS mismatch rather
  than hiding it).

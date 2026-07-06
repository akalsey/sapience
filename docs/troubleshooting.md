# Troubleshooting

## Start here: `openclaw sapience doctor`

The suite ships a diagnostic command that checks production reality — what the plugins actually resolved and wrote, not what the config says should happen:

```bash
openclaw sapience doctor
openclaw sapience doctor --fix    # apply the safe, auto-fixable findings
openclaw sapience doctor --json   # machine-readable report
openclaw sapience doctor --probe  # trigger one real thinking pass and verify it writes
```

What it checks:

- **PLUGINS** — all four plugins installed and initialized. Each plugin writes a status artifact at init (under `~/.openclaw/sapience/status/`) recording its version, agent, resolved workspace dir, and output paths; a missing or stale artifact means the plugin isn't loading. For sapience-feedback it also reports `captureMode` — `command-only` means passive capture is degraded and only `/feedback` works.
- **CRONS** — the three jobs exist, are enabled, aren't erroring, don't pin a disallowed model, and grant their tools via `payload.toolsAllow` (see below).
- **PATHS** — the resolved workspace dir, whether each output file exists, and — critically — whether pipeline files are **fresh**. A green cron with a stale `log.md`/`proposals.jsonl`/`events.jsonl` (older than 24h) is flagged as an error: the cron runs but the tool handlers never execute. Quarantined `.corrupt-*` files are reported here too.
- **MEMORY** — memory-wiki installed, plus the four settings the suite needs (`memory-core` dreaming, wiki bridge mode, bridge enabled, search corpus `all`).
- **VERSIONS** — skew between what the gateway is running and what's installed on disk (restart needed), stale legacy npm pins, and newer published versions.

`--fix` applies only the safe fixes: setting the memory config values and registering missing cron jobs (with the same arguments as `install.sh`). Everything else it reports with instructions. Exit code is non-zero when errors remain, so it's scriptable.

`--probe` goes beyond the static checks: it triggers one real `sapience-thinking` cron run (`openclaw cron run --wait`, up to ~3 minutes) and watches `log.md`/`proposals.jsonl` for writes. Verdicts:

- **pass** — the run wrote output; tool exposure, prompts, and the pipeline path all work
- **fail** — the run completed but nothing was written (the classic tools-not-granted signature, see below), or the run itself errored
- **inconclusive** — the run completed but writes are suppressed outside active hours; re-run within the window
- **blocked** — the plugin never initialized or the cron job isn't registered, so there's nothing to probe

---

## Tool exposure in cron sessions

**This failure mode took a production install down for weeks, silently.** Read this section if anything cron-driven isn't producing output.

The suite's crons run in isolated sessions. An isolated session only sees a plugin's tools if:

- the cron job's `payload.toolsAllow` grants them — that's the `--tools` flag on `openclaw cron add` (what `install.sh` uses), **or**
- a `tools.profile` is set and a global `tools.alsoAllow: ["group:plugins"]` grants plugin tools back to every session.

Without either, the run completes "ok" — the model reads the prompt, can't see the tool it's told to call, replies with something, and the run is recorded as a success. **The symptom is green cron runs with no output files** (or output files that stop getting fresher). Nothing errors. That's why the doctor treats "crons all green + no/stale output" as a hard error.

Inspect:

```bash
openclaw cron list --json | jq '.[] | {name, payload: {toolsAllow: .payload.toolsAllow}}'
```

Each suite job must grant exactly its tools (see [cron-setup.md](cron-setup.md) for the full list). Repair by deleting the job and re-registering it with `--tools` — re-run `install.sh` (it detects and offers to fix broken jobs), run `openclaw sapience doctor --fix` after deleting the bad job, or use the manual commands in [cron-setup.md](cron-setup.md).

---

## Other common problems

**Plugins installed but tools don't exist / old behavior persists**

The gateway loads plugins at startup. After `openclaw plugins install` or an update, **restart the gateway** — until then old code runs (or no code at all). The doctor's VERSIONS section flags running-vs-on-disk skew.

**Crons erroring with an `agents.defaults.models` allowlist message**

The job pins a `--model` the gateway doesn't permit; preflight rejects every run. Delete and re-register without `--model`.

**Nothing arrives in my session**

Deliveries are next-turn injections into the main session — they appear when you next take a turn, not as pushes. Check `<workspace>/sapience/events.jsonl` for `delivery_failed` events if turns come and go with nothing.

**A state file went missing / a `.corrupt-<timestamp>` file appeared**

State files that fail to parse are quarantined to `<name>.corrupt-<timestamp>` (evidence preserved) and rebuilt from empty. The doctor lists quarantined files. Note the corrupt-`processed-passes.json` case is benign: an empty processed set triggers a bootstrap that marks all existing passes processed, so nothing is re-delivered.

**Everything skips with `outside_hours`**

Expected outside your `activeHours` window (default 08:00–20:00 local). The skip event logs once per transition, not every 15 minutes, so a quiet events log overnight is normal. If it skips during the day, check the configured timezone — and look for a `config_invalid` event, which means your `activeHours` was malformed and the defaults are in effect.

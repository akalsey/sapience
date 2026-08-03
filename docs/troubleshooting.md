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
- **CRONS** — the four jobs exist, are enabled, aren't erroring, don't pin a disallowed model, and grant their tools via `payload.toolsAllow` (see below).
- **PATHS** — the resolved workspace dir, whether each output file exists, and — critically — whether pipeline files are **fresh**. A green cron with a stale `log.md`/`proposals.jsonl`/`events.jsonl` (older than 24h) is flagged as an error: the cron runs but the tool handlers never execute. Files that are simply cold-start absent say which activity creates them (`action-log.md` needs a first act-tier execution, `goals.json` a first `goal_submit`, `skill-proposals.json` a first `skill_proposal`) rather than reading as breakage. Quarantined `.corrupt-*` files are reported here too. This section also carries the **delivery target** check (below).
- **MEMORY** — memory-wiki installed, plus the four settings the suite needs (`memory-core` dreaming, wiki bridge mode, bridge enabled, search corpus `all`).
- **VERSIONS** — skew between what the gateway is running and what's installed on disk (restart needed — including a plugin whose *loaded* version trails the build on disk), stale legacy npm pins, and newer published versions. When a plugin is out of date against the registry, the fix is auto-fixable — the doctor runs `openclaw plugins update <id>`. (Re-running `install.sh` does **not** update an already-installed plugin; use the doctor or `openclaw plugins update`.)

`--fix` applies the safe fixes: setting the memory config values, registering missing cron jobs (with the same arguments as `install.sh`), routing deliveries to your operator conversation, and updating out-of-date suite plugins to the latest published version. After a plugin update it reminds you to restart the gateway (updates don't take effect until then). The post-fix report is re-gathered, so what it prints afterward reflects the config changes it just applied rather than the pre-fix state. Everything else it reports with instructions. Exit code is non-zero when errors remain, so it's scriptable.

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

## Deliveries going nowhere (`delivery:target`)

Injections land in the agent's main session by default. When `session.dmScope` isolates DMs into per-peer sessions, that session is machine-only — proposals delivered there ask questions no human will ever see, let alone answer. The doctor's `delivery:target` finding covers this:

- **ok** — `dmScope` is `main`, so DMs share the main session and deliveries reach you there.
- **warn, no key configured** — it names your most recent operator conversation and `--fix` sets `delivery.sessionKey` on sapience, sapience-thinking, and sapience-goals to point at it. If no operator conversation exists yet, message the assistant once from your chat app and re-run `--fix`.
- **warn, configured key missing from the session store** — the key has a typo, or the session was pruned; deliveries fall back to gateway resolution and may go nowhere.

Set it by hand with `openclaw config set plugins.entries.<id>.config.delivery.sessionKey '"agent:main:telegram:direct:12345"'` on each of the three delivering plugins — see [configuration.md](configuration.md#delivery-target).

---

## Other common problems

**Plugins installed but tools don't exist / old behavior persists**

The gateway loads plugins at startup. After `openclaw plugins install` or an update, **restart the gateway** — until then old code runs (or no code at all). The doctor's VERSIONS section flags running-vs-on-disk skew.

**Crons erroring with an `agents.defaults.models` allowlist message**

The job pins a `--model` the gateway doesn't permit; preflight rejects every run. Delete and re-register without `--model`.

**Nothing arrives in my session**

Most deliveries are next-turn injections — they appear when you next take a turn, not as pushes. Trace it through `<workspace>/sapience/events.jsonl`:

- `item_delivered` — the injection was accepted; it's waiting for your next turn.
- `item_queued` — the item overflowed `delivery.maxPerCycle` (default 1 per routing run) and is waiting for the `sapience-delivery` cron to send it, within 15 minutes.
- `delivery_failed` — the injection was declined (`reason` says why); the item falls back to the same pending queue.
- `item_suppressed` — the same finding was already delivered inside `delivery.dedupeWindowHours` (default 72h), so it was dropped rather than repeated.

If `delivery_failed` and `item_queued` are piling up but nothing reaches your chat, the `sapience-delivery` cron is the thing to check: it must exist, grant `get_pending_deliveries`, and be registered with `--announce` (plus `--channel`/`--to` when announce can't resolve a target). If deliveries are being *accepted* but you never see them, you're probably reading a different session than the one they land in — see the `delivery:target` section above.

**One proposal keeps arriving over and over**

Fixed in 0.4.22, but worth knowing the shape: the thinking model re-emits a persistent finding under a fresh id every pass, so pass-id dedupe never catches it. Routing now suppresses repeats by normalized text for `delivery.dedupeWindowHours`. If it still repeats, check `<workspace>/sapience/playbooks.json` — a one-time directive stored as a permanent analytical playbook gets re-read as an unexecuted mandate every pass. Delete the offending entry; the classifier no longer stores directives as playbooks, and over-long entries are rejected with a `playbook_rejected` event.

**Passes keep escalating a problem that really happened only once**

The tell is an observation graded `replicated` whose `evidence` field cites the pass's own context rather than any activity — "the Open Hypotheses section contains numerous entries", "recent passes consistently point to this". Fixed in 0.5.3. The shape: one incident gets written into the hypothesis ledger several times under different wording, dedup doesn't catch the restatements, and every later pass reads the pile as that many independent confirmations — escalating priority as it goes. A production ledger turned a single Google auth failure into 8 open cases and sustained a four-day "persistent critical blocker" narrative from them.

Check `<workspace>/sapience/hypotheses.json` for a cluster of entries all saying the same thing with `"sightings": 1` and `last_seen` equal to `first_seen`. Those are un-corroborated guesses, and they now expire on their own after 72h.

Deleting them is worth doing but **is not sufficient on its own** — there are two feeders. Clearing the production ledger did not stop the escalation: the very next pass cited "chronology of repeated P5 proposals in the last four thinking passes" instead and escalated again. The pass-history section feeds the loop independently of the ledger, and only the prompt changes close that one. If you are on a build before 0.5.3, expect the loop to continue from pass history even with an empty ledger; upgrading is the fix, and the gateway needs a restart to pick it up.

**Passes always say "no session activity" / the agent ignores what you told it**

The pass reads session transcripts from disk. If it resolves the wrong directory it reads *nothing*, and — before 0.5.4 — reported that as "No recent session activity found", identical to a genuinely quiet day. A pass in that state has only its own prior output and the hypothesis ledger to reason from, which is how a single incident becomes a multi-day "persistent outage" the agent will defend against your direct correction.

Check the status artifact at `~/.openclaw/sapience/status/sapience-thinking.json`:

```
"contextSessionsDir": "/home/you/.openclaw/agents/main/sessions",
"contextSessionsDirExists": "true"
```

If `contextSessionsDirExists` is `"false"`, the pass is blind. From 0.5.4 the resolver probes several layouts and then scans `agents/*/sessions` for one that exists, so this should self-correct; the artifact tells you which path won. Sessions live at `agents/<id>/sessions` — a sibling of `agents/<id>/agent/`, not a child of it — and the agent is `main` on a default install, not `default`.

**A supposed problem won't stay dead after you correct it**

Hypotheses are unsettled guesses that thinking passes write down and read back as context. Telling the agent in chat that something isn't real doesn't clear them — before 0.5.4 nothing could, so the agent would agree with you, write a note to memory, and keep re-reading the same open cases. Have it call `hypothesis_resolve` with a few words describing the subject, a verdict, and what you checked:

```
hypothesis_resolve({ match: "google auth", verdict: "refuted",
                     note: "verified working — oauth flow ran, list_drive_items succeeded" })
```

Every matching case is closed at once, so one correction clears a fragmented cluster. `hypothesis_list` shows what's currently open. Settled cases stop feeding passes immediately; refuted ones are kept 7 days for dedup, then dropped.

**The agent re-asks something you already answered, 15 minutes later**

Deliveries are capped per cycle (`delivery.maxPerCycle`, default 1) and the overflow waits in `<workspace>/sapience/pending-deliveries.json`, which the `sapience-delivery` cron drains every 15 minutes. Before 0.5.6 nothing reconsidered that queue, so a burst of proposals written in one minute arrived over the following hours — including after you'd answered them. In production one pass produced an observation and the action derived from it; the user gave direction on the observation at 11:16 and the sibling action shipped at 11:30 as a fresh "would you like me to, or shall I check with you first?" about the very thing just settled.

From 0.5.6, `record_outcome` retires queued deliveries that the answer speaks for — anything from the same pass, plus near-identical text from other passes — and logs a `stale_deliveries_dropped` event naming what went. Nothing is needed from you beyond letting the agent record the outcome, which the delivered prompt already instructs it to do.

If it still repeats, check whether the repeats carry *different* `proposal_id`s from *different* passes written seconds apart. That is a separate fault — see below.

**The same observation shows up several times in slightly different words**

Two causes, both fixed in 0.5.7 — and they compounded, so you may have been seeing them together.

*Accumulating transcript listeners.* Look for several `noticed` events for one session within a second or two. Post-task noticing fires once per turn per cooldown (`noticing.cooldownMinutes`, default 15), but `register()` runs more than once per gateway process and each run used to subscribe another watcher. One turn then ran one side-pass per accumulated listener — a production install reached nine, and 82% of bursts over 27 days fired more than once. Because each side-pass is an independent LLM call over the same transcript, each words the same remark differently, which is precisely what text dedup cannot collapse. If the `watcher` values on those events differ while `pid` stays the same, that's this. Fixed by keeping one watcher per process.

*Restatements slipping past dedup.* A pass that can read your conversation will re-observe an unresolved situation every 15 minutes, and each re-description is worded differently. Plain token-overlap scoring gets *worse* as a description grows, because the extra words count against it — production sent the same "stuck in a failure loop" observation four times in 75 minutes at priority 5, and no two of them scored close to the duplicate threshold. Matching now also accepts containment, which catches "B restates A with more detail".

Setting `noticing.enabled: false` disables incidental noticing outright if the noise still outweighs the value.

**A proposal I haven't answered keeps coming back**

Check `<workspace>/sapience/pending-deliveries.json`. Overflow beyond `delivery.maxPerCycle` waits there and the `sapience-delivery` cron releases one per cycle, so a batch of near-identical items queued in the same second reaches you as the same point repeated over hours. From 0.5.7 a restatement of something already queued is never added, so the queue holds one entry per finding.

Queued items are deliberately **not** aged out — a proposal may legitimately sit for days until you get to it — so a full queue after a quiet week is expected, not a fault.

**A state file went missing / a `.corrupt-<timestamp>` file appeared**

State files that fail to parse are quarantined to `<name>.corrupt-<timestamp>` (evidence preserved) and rebuilt from empty. The doctor lists quarantined files. Note the corrupt-`processed-passes.json` case is benign: an empty processed set triggers a bootstrap that marks all existing passes processed, so nothing is re-delivered.

**Everything skips with `outside_hours`**

Expected outside your `activeHours` window (default 08:00–20:00 local). The skip event logs once per transition, not every 15 minutes, so a quiet events log overnight is normal. If it skips during the day, check the configured timezone — and look for a `config_invalid` event, which means your `activeHours` was malformed and the defaults are in effect.

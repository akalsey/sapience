import { randomUUID } from "crypto";
import { appendStructuredProposals } from "./log-writer.js";
import { loadOutcomes, saveOutcomes, addProposals } from "./outcome-tracker.js";
import { dedupeProposals } from "./dedup.js";
import { extractTranscriptMessage } from "./utils.js";
import type { Observation, ProposalSet } from "./types.js";

// Post-task incidental noticing: humans notice things IN PASSING, during
// work — "while I was pulling the Salesforce report I saw three duplicate
// Apple accounts." The scheduled thinking pass can't do that; this watcher
// can. It observes session transcript updates, and when a substantial turn
// completes it runs a cheap side-pass over the turn asking one question:
// what crossed your path that wasn't the point of the task? Findings become
// hunch-graded observations in proposals.jsonl with provenance, so they flow
// through the normal routing/investigation/evidence machinery.

interface TranscriptUpdate {
  sessionKey?: string;
  message?: unknown;
}

interface WatcherOptions {
  minTurnChars: number;
  cooldownMs: number;
  onTurn: (sessionKey: string, turnText: string) => void;
}

// Gateway subsystems whose sessions are machine-driven even though their keys
// have a channel-like extra segment.
const MACHINE_SUBSYSTEMS = new Set(["cron", "subagent"]);

// Only watch sessions bound to a user-facing channel. Gateway session keys are
// `agent:<agentId>:<rest>`; a channel session's rest has at least two segments
// (`telegram:direct:<peer>`, `slack:channel:<id>`), while machine sessions are
// either single-segment (`main`, `current`, custom labels like
// `dreaming-narrative-rem-<id>`) or namespaced under cron/subagent.
export function isNoticeableSession(key: string): boolean {
  const parts = key.split(":");
  if (parts.length < 4 || parts[0] !== "agent") return false;
  return !MACHINE_SUBSYSTEMS.has(parts[2]!);
}

export class TurnWatcher {
  private buffers = new Map<string, string[]>();
  private lastNotice = new Map<string, number>();

  // Production emits several side-passes for a single turn — four in 604ms on
  // 2026-08-02, and 82% of bursts over 27 days involved more than one fire.
  // The cooldown below provably prevents that within one instance (see the
  // cooldown test), so the duplicates must come from somewhere else. Tagging
  // each watcher, and reporting the tag with the pid on every `noticed` event,
  // tells the three candidates apart: distinct tags on one pid means listeners
  // are accumulating in a process that never unsubscribes; one tag across
  // several pids means several gateway processes share these files; a single
  // tag firing repeatedly would mean the guard itself is wrong.
  readonly instanceId = randomUUID().slice(0, 8);

  constructor(private opts: WatcherOptions) {}

  // Adopt a later registration's config without discarding buffers or the
  // per-session cooldown clock.
  reconfigure(opts: WatcherOptions): void {
    this.opts = opts;
  }

  observe(update: TranscriptUpdate): void {
    const key = update.sessionKey ?? "";
    if (!isNoticeableSession(key)) return;

    const msg = extractTranscriptMessage(update.message);
    if (!msg) return;

    const buffer = this.buffers.get(key) ?? [];
    buffer.push(`[${msg.role}]: ${msg.text.slice(0, 2000)}`);
    this.buffers.set(key, buffer.slice(-30));

    if (msg.role !== "assistant") return;

    const turnText = (this.buffers.get(key) ?? []).join("\n");
    this.buffers.set(key, []);

    if (turnText.length < this.opts.minTurnChars) return;
    const last = this.lastNotice.get(key) ?? 0;
    if (Date.now() - last < this.opts.cooldownMs) return;
    this.lastNotice.set(key, Date.now());

    this.opts.onTurn(key, turnText);
  }
}

// One watcher per process, however many times register() runs.
//
// Confirmed in production 2026-08-03: four `noticed` events for a single turn
// carrying four distinct watcher ids and one pid. register() executes more than
// once per gateway process, and the old code built a new TurnWatcher and
// subscribed it every time, discarding whatever the runtime handed back. The
// listeners accumulated, so one turn ran one side-pass per accumulated
// listener. Each of those is an independent LLM call over the same transcript,
// so they word the same remark differently — which is what got past text dedup
// downstream and reached the user as several near-identical proposals.
//
// Keeping this at module scope rather than inside register() is the point: it
// has to outlive the registration that created it.
let installed: { watcher: TurnWatcher; dispose?: () => void } | null = null;

export function installTurnWatcher(
  subscribe: (listener: (update: unknown) => void) => unknown,
  opts: WatcherOptions
): TurnWatcher {
  // A later registration carries fresher config, so the live watcher adopts it
  // rather than being replaced — swapping instances would lose the per-session
  // cooldown state that stops a burst in the first place.
  if (installed) {
    installed.watcher.reconfigure(opts);
    // Only re-subscribe when the runtime gave us a way to detach the previous
    // listener. Without a disposer, subscribing again is exactly the leak.
    if (installed.dispose) {
      installed.dispose();
      installed.dispose = asDisposer(subscribe((u) => installed?.watcher.observe(u as TranscriptUpdate)));
    }
    return installed.watcher;
  }
  const watcher = new TurnWatcher(opts);
  const handle = subscribe((u) => watcher.observe(u as TranscriptUpdate));
  installed = { watcher, dispose: asDisposer(handle) };
  return watcher;
}

function asDisposer(handle: unknown): (() => void) | undefined {
  return typeof handle === "function" ? (handle as () => void) : undefined;
}

// Tests only: module state would otherwise leak between cases.
export function resetInstalledTurnWatcher(): void {
  installed = null;
}

export function buildNoticerPrompt(turnText: string): string {
  return `An agent just completed the exchange below. You are its peripheral vision. List anything ANOMALOUS or NOTEWORTHY that crossed its path INCIDENTALLY — data quality smells (duplicates, dead links, missing fields), surprising numbers, possible patterns — that was NOT the subject of the task itself. The task's own outcome is not an observation.

Exchange:
${turnText.slice(0, 8000)}

Be very selective — an empty list is the normal answer. Respond with ONLY a JSON array (no prose):
[{"text":"<what you noticed>","evidence":"<where in this exchange you saw it>","priority":1-5}]
or [] if nothing genuinely stood out.`;
}

export function parseNoticedObservations(text: string): Array<Pick<Observation, "text" | "evidence" | "priority">> {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: Array<Pick<Observation, "text" | "evidence" | "priority">> = [];
  for (const raw of parsed) {
    const o = raw as { text?: unknown; evidence?: unknown; priority?: unknown };
    if (typeof o.text !== "string" || !o.text.trim()) continue;
    const priority = Math.min(5, Math.max(1, Math.round(typeof o.priority === "number" ? o.priority : 3))) as 1 | 2 | 3 | 4 | 5;
    out.push({
      text: o.text.slice(0, 500),
      evidence: typeof o.evidence === "string" ? o.evidence.slice(0, 300) : "",
      priority,
    });
  }
  return out;
}

export async function recordNoticedObservations(
  observations: Array<Pick<Observation, "text" | "evidence" | "priority">>,
  ctx: { proposalsPath: string; trackerPath: string; sessionKey: string }
): Promise<ProposalSet | null> {
  if (observations.length === 0) return null;
  const pass: ProposalSet = {
    pass_id: `notice-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    nothing_to_report: false,
    summary: `Incidental observations from a task in session ${ctx.sessionKey}`,
    observations: observations.map((o) => ({
      id: randomUUID(),
      text: o.text,
      evidence: o.evidence,
      priority: o.priority,
      // Incidental sightings are unverified by definition — grade as hunch so
      // routing gates them and investigation can pick them up.
      evidence_grade: "hunch" as const,
    })),
    proposed_actions: [],
    proposed_audits: [],
    open_questions: [],
  };
  // Same repeat-guard as scheduled passes: don't re-notice what's already in
  // recent history (including open hypotheses that came from prior notices).
  const outcomes = await loadOutcomes(ctx.trackerPath);
  const { kept } = dedupeProposals(pass, outcomes);
  if (kept.observations.length === 0) return null;
  await appendStructuredProposals(kept, ctx.proposalsPath);
  await saveOutcomes(addProposals(outcomes, kept), ctx.trackerPath);
  return kept;
}

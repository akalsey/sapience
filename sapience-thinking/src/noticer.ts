import { randomUUID } from "crypto";
import { appendStructuredProposals } from "./log-writer.js";
import { loadOutcomes, saveOutcomes, addProposals } from "./outcome-tracker.js";
import { dedupeProposals } from "./dedup.js";
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

function extractText(message: unknown): { role: string; text: string } | null {
  const line = message as { message?: { role?: string; content?: unknown }; role?: string; content?: unknown } | undefined;
  if (!line || typeof line !== "object") return null;
  const src = line.message && typeof line.message === "object" ? line.message : line;
  const role = src.role;
  if (role !== "user" && role !== "assistant") return null;
  const content = src.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join(" ");
  }
  return text ? { role, text } : null;
}

export class TurnWatcher {
  private buffers = new Map<string, string[]>();
  private lastNotice = new Map<string, number>();

  constructor(private opts: WatcherOptions) {}

  observe(update: TranscriptUpdate): void {
    const key = update.sessionKey ?? "";
    // Never watch the suite's own machine sessions — a noticer noticing its
    // own investigations would recurse forever.
    if (!key || key.startsWith("sapience-")) return;

    const msg = extractText(update.message);
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

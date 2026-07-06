import type { RoutedItem, SapienceConfig } from "./types.js";
import { appendEvent } from "./events.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";
import { localDateIn, notePush, type PushState } from "./push.js";
import { noteSighting, recordVerdict } from "./hypotheses.js";
import { runSubagentForText } from "./utils.js";

// Bounded follow-up on hunches: a hunch-graded item worth surfacing gets a
// capped, read-only subagent run to test whether the pattern holds before the
// user sees it. Supported hunches upgrade to quick_check and re-route;
// refuted ones are dropped (with an event); inconclusive ones stay gated at
// explore. Budgeted per local day — the failure mode is an agent disappearing
// down rabbit holes on the analytics bill.

export interface InvestigationVerdict {
  verdict: "supported" | "refuted" | "inconclusive";
  summary: string;
}

export function buildInvestigationPrompt(item: RoutedItem): string {
  return `You are running a bounded, READ-ONLY investigation of a hypothesis a thinking pass produced. Do not modify anything, anywhere — no writes, no sends, no state changes. Run AT MOST three read-only queries or lookups with the tools available, then stop.

Hypothesis: ${item.text}
Domain: ${item.domain}

Test whether the hypothesis holds against broader data. Be statistically honest: note sample size, obvious confounds, and whether what you found is signal or noise. If you cannot test it with the tools you have, say so.

End your reply with ONLY a single JSON object on its own line:
{"verdict":"supported"|"refuted"|"inconclusive","summary":"<one sentence of what you found, with numbers>","n":<sample size or null>}`;
}

export function parseVerdict(text: string): InvestigationVerdict {
  const matches = text.match(/\{[^{}]*"verdict"[^{}]*\}/g);
  const last = matches?.[matches.length - 1];
  if (last) {
    try {
      const parsed = JSON.parse(last) as { verdict?: string; summary?: string };
      if (parsed.verdict === "supported" || parsed.verdict === "refuted" || parsed.verdict === "inconclusive") {
        return { verdict: parsed.verdict, summary: typeof parsed.summary === "string" ? parsed.summary : "" };
      }
    } catch { /* fall through */ }
  }
  return { verdict: "inconclusive", summary: "no parseable verdict from the investigation" };
}

async function investigate(api: any, item: RoutedItem, timeoutSec: number): Promise<InvestigationVerdict | null> {
  const result = await runSubagentForText(api, `sapience-investigation-${item.id}`, {
    message: buildInvestigationPrompt(item),
    extraSystemPrompt: "READ-ONLY investigation session: you must not modify, create, send, or delete anything. Verify a hypothesis with at most three read-only queries, then report.",
    lightContext: true,
  }, timeoutSec * 1000, 50);
  if (result === null) return null;
  if (result.status !== "ok") return { verdict: "inconclusive", summary: `investigation ${result.status}${result.error ? `: ${result.error}` : ""}` };
  return parseVerdict(result.text);
}

export async function investigateHunches(
  routed: RoutedItem[],
  api: any,
  config: SapienceConfig,
  reroute: (item: RoutedItem) => RoutedItem
): Promise<RoutedItem[]> {
  if (!config.investigation.enabled) return routed;

  const out: RoutedItem[] = [];
  const localDate = localDateIn(config.activeHours.timezone);

  for (const item of routed) {
    const eligible = item.evidence_grade === "hunch" && item.priority >= config.investigation.minPriority;
    if (!eligible) { out.push(item); continue; }

    // Every eligible hunch becomes (or updates) a case in the hypothesis
    // ledger — even when budget or runtime blocks investigating it today.
    const hypothesis = await noteSighting(config.output.hypothesesPath, item)
      .catch(() => null);

    const state = await readJsonSafe<PushState>(config.output.investigationStatePath, { date: "", count: 0 });
    const spentToday = state.date === localDate ? state.count : 0;
    if (spentToday >= config.investigation.maxPerDay) { out.push(item); continue; }

    await writeJsonAtomic(config.output.investigationStatePath, notePush(state, localDate));
    const verdict = await investigate(api, item, config.investigation.timeoutSec);
    if (verdict === null) { out.push(item); continue; } // runtime unavailable

    await appendEvent(config.output.eventsPath, {
      plugin: "sapience", type: "investigation_completed",
      proposal_id: item.id, domain: item.domain, verdict: verdict.verdict,
    });
    if (hypothesis) {
      await recordVerdict(config.output.hypothesesPath, hypothesis.id, verdict.verdict, verdict.summary)
        .catch(() => {});
    }

    if (verdict.verdict === "refuted") continue; // drop — the event is the trace
    if (verdict.verdict === "supported") {
      out.push(reroute({
        ...item,
        evidence_grade: "quick_check",
        text: `${item.text}\n\nQuick check: ${verdict.summary}`,
      }));
      continue;
    }
    out.push(item); // inconclusive: stays gated as a hunch
  }
  return out;
}

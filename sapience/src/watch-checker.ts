import type { SapienceConfig } from "./types.js";
import { dueWatches, evaluateReading, recordReading, markChecked, type Watch } from "./watches.js";
import { appendEvent } from "./events.js";
import { enqueueMainSessionInjection } from "./main-session.js";
import { shouldPush, notePush, requestChannelPush, localDateIn, type PushState } from "./push.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

// Checks due watches during routing passes: a bounded read-only subagent
// fetches the current value, the delta policy decides whether it's worth
// surfacing. Steady readings stay in the event stream; notable moves go to
// the main session and (budget permitting) push through the channel.

export function buildWatchFetchPrompt(watch: Watch): string {
  return `You are performing a READ-ONLY metric check. Do not modify anything. Fetch ONE number and stop.

Metric: ${watch.name}
How to find it: ${watch.query_hint}

End your reply with ONLY a single JSON object on its own line:
{"value": <the number>} — or {"value": null, "reason": "<why you couldn't fetch it>"}`;
}

export function parseWatchValue(text: string): number | null {
  const matches = text.match(/\{[^{}]*"value"[^{}]*\}/g);
  const last = matches?.[matches.length - 1];
  if (!last) return null;
  try {
    const parsed = JSON.parse(last) as { value?: unknown };
    return typeof parsed.value === "number" && Number.isFinite(parsed.value) ? parsed.value : null;
  } catch {
    return null;
  }
}

function extractAssistantText(messages: unknown[]): string {
  const texts: string[] = [];
  for (const raw of messages) {
    const line = raw as { message?: { role?: string; content?: unknown }; role?: string; content?: unknown };
    const src = line.message && typeof line.message === "object" ? line.message : line;
    if (src.role !== "assistant") continue;
    if (typeof src.content === "string") texts.push(src.content);
    else if (Array.isArray(src.content)) {
      for (const c of src.content) {
        if (c && typeof c === "object" && (c as { type?: string }).type === "text") texts.push((c as { text?: string }).text ?? "");
      }
    }
  }
  return texts.join("\n");
}

async function fetchWatchValue(api: any, watch: Watch, timeoutSec: number): Promise<number | null> {
  const subagent = api?.runtime?.subagent;
  if (!subagent || typeof subagent.run !== "function") return null;
  const sessionKey = `sapience-watch-${watch.id}`;
  try {
    const { runId } = await subagent.run({
      sessionKey,
      message: buildWatchFetchPrompt(watch),
      extraSystemPrompt: "READ-ONLY metric check: fetch one number with at most two queries, modify nothing.",
      lightContext: true,
      deliver: false,
    });
    const wait = await subagent.waitForRun({ runId, timeoutMs: timeoutSec * 1000 });
    if (wait.status !== "ok") return null;
    const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 30 });
    return parseWatchValue(extractAssistantText(messages ?? []));
  } catch {
    return null;
  } finally {
    try { await subagent.deleteSession({ sessionKey }); } catch { /* best effort */ }
  }
}

export async function checkDueWatches(api: any, config: SapienceConfig): Promise<void> {
  if (!api?.runtime?.subagent?.run) return;
  const due = await dueWatches(config.output.watchesPath);
  for (const watch of due.slice(0, config.watch.maxChecksPerRun)) {
    const value = await fetchWatchValue(api, watch, config.watch.timeoutSec);

    if (value === null) {
      // Stamp the check so an unfetchable metric doesn't get hammered every run.
      await markChecked(config.output.watchesPath, watch.id);
      await appendEvent(config.output.eventsPath, {
        plugin: "sapience", type: "watch_check_failed", watch: watch.name,
      });
      continue;
    }

    const verdict = evaluateReading(value, watch.readings, watch.delta_policy);
    await recordReading(config.output.watchesPath, watch.id, value);
    await appendEvent(config.output.eventsPath, {
      plugin: "sapience", type: "watch_checked", watch: watch.name, value, notable: verdict.notable,
    });

    if (!verdict.notable) continue;

    const delivery = await enqueueMainSessionInjection(api, `[SAPIENCE: WATCH] A watched metric moved notably.

Watch: ${watch.name}
Reading: ${verdict.summary}

Tell the user, with the number and the baseline. If it looks like an incident (tracking outage vs real change), say which you suspect and offer to dig in.`);
    if (!delivery.enqueued) {
      await appendEvent(config.output.eventsPath, {
        plugin: "sapience", type: "delivery_failed", what: "watch", watch: watch.name, reason: delivery.reason,
      });
      continue;
    }

    const localDate = localDateIn(config.activeHours.timezone);
    const state = await readJsonSafe<PushState>(config.output.pushStatePath, { date: "", count: 0 });
    if (shouldPush({ tier: "propose", priority: 4 }, config.push, state, localDate)) {
      await writeJsonAtomic(config.output.pushStatePath, notePush(state, localDate));
      requestChannelPush(api, `sapience watch: ${watch.name}`);
    }
  }
}

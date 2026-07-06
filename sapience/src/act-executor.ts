import type { RoutedItem, SapienceConfig } from "./types.js";
import { appendAction } from "./action-log.js";
import { appendEvent } from "./events.js";
import { enqueueMainSessionInjection } from "./main-session.js";
import { buildTierPrompt } from "./delivery.js";
import { shouldPush, notePush, requestChannelPush, localDateIn, type PushState } from "./push.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

// Act-tier execution. The old mechanics injected "execute immediately" into
// the main session — which still waited for the user's next turn and then
// hijacked it. Acts now run in an isolated subagent session at routing time;
// the main session gets the RESULT ("I archived the three duplicates —
// reversible via the recycle bin"), which is what acting autonomously
// actually means. Reversibility is already gated upstream in routeItem.

export interface ActResult {
  status: "done" | "failed";
  report: string;
  undo?: string;
}

export function buildActPrompt(item: RoutedItem): string {
  return `You are executing a pre-approved autonomous action (the user's calibration profile authorizes this domain at the act tier, and the action was marked reversible).

Action: ${item.text}
Domain: ${item.domain} / ${item.action_class}

Execute it now with your available tools. Prefer the most reversible path (archive over delete, draft over send). If anything looks riskier than described, STOP and report "failed" with what you saw instead of pushing through.

End your reply with ONLY a single JSON object on its own line:
{"status":"done"|"failed","report":"<one sentence: what you did or why you stopped>","undo":"<how to reverse it, or null>"}`;
}

export function parseActResult(text: string): ActResult {
  const matches = text.match(/\{[^{}]*"status"[^{}]*\}/g);
  const last = matches?.[matches.length - 1];
  if (last) {
    try {
      const parsed = JSON.parse(last) as { status?: string; report?: string; undo?: string | null };
      if (parsed.status === "done" || parsed.status === "failed") {
        return {
          status: parsed.status,
          report: typeof parsed.report === "string" ? parsed.report : "",
          ...(typeof parsed.undo === "string" ? { undo: parsed.undo } : {}),
        };
      }
    } catch { /* fall through */ }
  }
  return { status: "failed", report: "no parseable result from the execution session" };
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

async function runAct(api: any, item: RoutedItem, timeoutSec: number): Promise<ActResult | null> {
  const subagent = api?.runtime?.subagent;
  if (!subagent || typeof subagent.run !== "function") return null;
  const sessionKey = `sapience-act-${item.id}`;
  try {
    const { runId } = await subagent.run({
      sessionKey,
      message: buildActPrompt(item),
      deliver: false,
    });
    const wait = await subagent.waitForRun({ runId, timeoutMs: timeoutSec * 1000 });
    if (wait.status !== "ok") return { status: "failed", report: `execution ${wait.status}` };
    const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 50 });
    return parseActResult(extractAssistantText(messages ?? []));
  } catch (err) {
    return { status: "failed", report: `execution error: ${String(err)}` };
  } finally {
    try { await subagent.deleteSession({ sessionKey }); } catch { /* best effort */ }
  }
}

function buildResultReport(item: RoutedItem, result: ActResult): string {
  const outcome = result.status === "done" ? "acted_on" : "rejected";
  return `[SAPIENCE: ACT RESULT] An autonomous action just ${result.status === "done" ? "completed" : "FAILED"}.

Action: ${item.text}
Result: ${result.report}${result.undo ? `\nReversible via: ${result.undo}` : ""}

Tell the user briefly what happened${result.status === "failed" ? " and ask whether to try differently" : ""}. Then record it: record_outcome({ proposal_id: "${item.id}", outcome: "${outcome}", domain: "${item.domain}", action_class: "${item.action_class}" }).`;
}

export async function executeActItems(items: RoutedItem[], api: any, config: SapienceConfig): Promise<void> {
  for (const item of items) {
    const result = await runAct(api, item, config.act.timeoutSec);

    if (result === null) {
      // No subagent runtime: fall back to the legacy act injection.
      await enqueueMainSessionInjection(api, buildTierPrompt(item));
      continue;
    }

    await appendAction(item, `${result.status === "done" ? "Executed" : "Execution FAILED"}: ${result.report}${result.undo ? ` (undo: ${result.undo})` : ""}`, config.output.actionLogPath);
    await appendEvent(config.output.eventsPath, {
      plugin: "sapience",
      type: result.status === "done" ? "act_executed" : "act_failed",
      proposal_id: item.id,
      domain: item.domain,
      report: result.report,
    });

    const delivery = await enqueueMainSessionInjection(api, buildResultReport(item, result));
    if (!delivery.enqueued) {
      await appendEvent(config.output.eventsPath, {
        plugin: "sapience", type: "delivery_failed", tier: "act", domain: item.domain, reason: delivery.reason,
      });
      continue;
    }

    // A completed (or failed) autonomous action is worth initiating contact
    // for — same budget as ordinary pushes.
    const localDate = localDateIn(config.activeHours.timezone);
    const state = await readJsonSafe<PushState>(config.output.pushStatePath, { date: "", count: 0 });
    if (shouldPush(item, config.push, state, localDate)) {
      await writeJsonAtomic(config.output.pushStatePath, notePush(state, localDate));
      requestChannelPush(api, `sapience act result (${item.domain})`);
    }
  }
}

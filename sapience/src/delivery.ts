import type { RoutedItem, SapienceConfig } from "./types.js";
import { appendAction } from "./action-log.js";
import { appendEvent } from "./events.js";
import { enqueueMainSessionInjection } from "./main-session.js";
import { addPendingDelivery } from "./pending-deliveries.js";
import { shouldPush, notePush, requestChannelPush, localDateIn, type PushState } from "./push.js";
import { splitByCalibrateBudget, noteCalibrateUse, type DailyCount } from "./calibrate-budget.js";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

// The recording instruction closes the learning loop: without it every
// proposal stayed "pending" until expiry and the signal analyzer learned from
// vacuum. record_outcome is sapience-thinking's tool; the ids come from here.
function outcomeInstruction(item: RoutedItem, guidance: string): string {
  return `${guidance} record_outcome({ proposal_id: "${item.id}", outcome: <outcome>, domain: "${item.domain}", action_class: "${item.action_class}" }).`;
}

// Injections prepend to whatever turn comes next — often the user's own
// message. The note must never win that priority fight: a delivered proposal
// once hijacked the turn where the user was submitting a goal, and the agent
// answered the proposal instead of the user.
const USER_FIRST =
  "(If the user's own message accompanies this note, the user's message takes priority — respond to it first and fully, then surface this briefly or hold it for a natural moment.)\n\n";

// Where this note came from, and what it is not. A thinking pass runs in
// isolation on a cron and reads no session transcripts, so anything it says
// about the CURRENT state of the world is inference from stale artifacts.
// Without this, deliveries read as an independent monitoring signal and
// outrank the agent's own eyes: production ran the Google auth flow, confirmed
// it working with a successful list_drive_items call, said so to the user, and
// twelve minutes later declared "the cron job's message just now is definitive
// proof that the Google Authentication issue is not resolved" — apologizing
// for having reported the truth. The pass behind that note had seen none of
// the conversation, including the user twice saying the problem wasn't real.
const PROVENANCE =
  "(Provenance: this came from a background thinking pass that did not see this conversation, did not run any check just now, and may be reasoning from stale or already-corrected information. It is a suggestion to weigh, not confirmation that anything is true. Your own first-hand evidence outranks it — a tool call you ran, something you observed, something the user told you. If it contradicts what you have directly observed or what the user has already corrected you on, say so plainly and trust the direct evidence. The arrival of this note is not proof the problem is real, and it is not a reason to apologize for having been right.)\n\n";

// The user reads these notes daily; a scripted sentence repeated verbatim on
// every delivery reads as machinery, not judgment. The instructions below
// describe CONTENT — the model supplies the wording.
const OWN_WORDS =
  "\n\nWrite the note in your own words, matched to the conversation's tone, and vary your phrasing from previous notes — these instructions describe what to convey, not what to say. Never quote them verbatim.";

export function buildTierPrompt(item: RoutedItem): string {
  return buildBatchPrompt([item]);
}

// One routing run puts ONE note in front of the user. When several items ship
// together they share the priority guard and the own-words instruction rather
// than repeating them per item: a turn once arrived carrying 15 separate
// CALIBRATE notes and 15 copies of "the user's message takes priority" ahead
// of a 23-character user message, and no model reads the sixth copy of "this
// is secondary" as secondary.
export function buildBatchPrompt(items: RoutedItem[]): string {
  return USER_FIRST + PROVENANCE + items.map(tierPromptBody).join("\n\n---\n\n") + OWN_WORDS;
}

function tierPromptBody(item: RoutedItem): string {
  switch (item.tier) {
    case "act":
      return `[SAPIENCE: ACT] High-confidence action — execute immediately without asking the user for approval, then notify them briefly.

Action: ${item.text}
Domain: ${item.domain} / ${item.action_class}
Confidence: ${(item.confidence * 100).toFixed(0)}%

Execute now. Afterwards tell the user what you did and whether it can be undone — a sentence or two.
${outcomeInstruction(item, 'Then record it: use "acted_on" (or "rejected" if execution failed or you had to abort) in')}`;

    case "propose":
      return `[SAPIENCE: PROPOSE] A thinking pass identified this as worth doing. Surface it to the user for approval.

Proposal: ${item.text}
Priority: ${item.priority}/5
Domain: ${item.domain} / ${item.action_class}

Present this concisely and ask if they'd like you to proceed.
${outcomeInstruction(item, 'After they respond, record their reaction — "acted_on" if they said yes or did it, "rejected" if they declined, "acknowledged" if they deferred — via')}`;

    case "ask":
      return `[SAPIENCE: ASK] You're capable of this but need information to proceed. Ask the user for exactly what you need.

Action: ${item.text}
Domain: ${item.domain} / ${item.action_class}

State what you can do, then ask the one or two specific questions that would unblock you.
${outcomeInstruction(item, 'After they respond, record it — "acted_on" if they unblocked you, "rejected" if they shut it down, "acknowledged" otherwise — via')}`;

    case "explore":
      return `[SAPIENCE: EXPLORE] A problem was identified but the right approach isn't obvious. Present it with options.

Problem: ${item.text}
Priority: ${item.priority}/5
Domain: ${item.domain} / ${item.action_class}

Name the problem, offer 2–3 concrete approaches with their tradeoffs, and ask which fits what they're trying to accomplish.
${outcomeInstruction(item, 'After they respond, record their reaction — "acted_on" if they picked an approach, "rejected" if they dismissed the problem, "acknowledged" if they deferred — via')}`;

    case "learning":
      return `[SAPIENCE: CALIBRATE] This domain/action class hasn't been calibrated yet. Check with the user before routing.

Item: ${item.text}
Domain: ${item.domain} / ${item.action_class}
Current confidence: ${(item.confidence * 100).toFixed(0)}%

You're finding out how much initiative the user wants here. Convey three things: what you noticed, what you'd do about it on your own if trusted, and whether they'd want you to just do that next time or check in first.
${outcomeInstruction(item, 'After they respond, record their reaction — "accepted" if they endorsed the instinct, "rejected" if they wanted less initiative, "acknowledged" if unclear — via')}`;
  }
}

// Both the overflow path (over maxPerCycle) and the failed-injection
// fallback hand the item to the same durable queue the delivery cron drains;
// share the construction so the two can't drift on shape.
async function queueForDeliveryCron(item: RoutedItem, config: SapienceConfig): Promise<boolean> {
  // `text` carries the raw finding so the queue can reject a restatement of
  // something already waiting — the prompt alone can't, being mostly shared
  // tier boilerplate.
  return addPendingDelivery(config.output.pendingDeliveriesPath, {
    id: item.id, kind: "item", prompt: buildTierPrompt(item), text: item.text,
  }).catch(() => false);
}

export async function deliverItems(
  items: RoutedItem[],
  api: any,
  config: SapienceConfig
): Promise<void> {
  const sorted = [...items].sort((a, b) =>
    ((a.tier === "act" ? 0 : 1) - (b.tier === "act" ? 0 : 1)) || (b.priority - a.priority)
  );

  // Bound the day's CALIBRATE volume before anything is delivered OR queued.
  // Over-budget items are dropped outright rather than deferred: a runaway that
  // queues today just arrives tomorrow, and calibration signal is fungible —
  // the point is a few samples, not every instance. See calibrate-budget.ts for
  // the day this became necessary.
  const localDate = localDateIn(config.activeHours.timezone);
  const budgetState = await readJsonSafe<DailyCount>(config.output.calibrateStatePath, { date: "", count: 0 });
  const { admitted, overBudget } = splitByCalibrateBudget(
    sorted, budgetState, localDate, config.delivery?.maxCalibratePerDay ?? 3
  );
  for (const item of overBudget) {
    await appendEvent(config.output.eventsPath, {
      plugin: "sapience", type: "calibrate_budget_exhausted",
      proposal_id: item.id, domain: item.domain, priority: item.priority,
    });
  }
  // Counts what was SELECTED for delivery, not what was confirmed delivered —
  // the same shape as notePush, which also writes before the send is known to
  // have landed. An admitted item can still fall out later (the pending queue
  // rejects a duplicate id or a restatement), and its slot is not refunded. So
  // the ceiling can under-deliver slightly, never over-deliver, which is the
  // safe direction for a circuit breaker.
  const admittedCalibrate = admitted.filter((i) => i.tier === "learning").length;
  if (admittedCalibrate > 0) {
    await writeJsonAtomic(
      config.output.calibrateStatePath,
      noteCalibrateUse(budgetState, localDate, admittedCalibrate)
    ).catch(() => {});
  }
  if (admitted.length === 0) return;

  // A routing run can drain a whole backlog of thinking passes (19 in one run
  // the morning after active hours resumed); injecting them all buries the
  // user under a wall of boilerplate in one turn. Take the top few, queue the
  // rest — the delivery cron composes queued items into one concise message.
  // The cap spans the RUN: callers pass every item from every pass they
  // drained, because enforcing it per pass multiplied it by the backlog depth.
  const maxPerCycle = config.delivery?.maxPerCycle ?? 1;
  const selected = admitted.slice(0, maxPerCycle);
  const overflow = admitted.slice(maxPerCycle);
  for (const item of overflow) {
    const queued = await queueForDeliveryCron(item, config);
    await appendEvent(config.output.eventsPath, {
      plugin: "sapience", type: "item_queued", proposal_id: item.id, tier: item.tier, priority: item.priority, queued,
    });
  }
  if (selected.length === 0) return;

  for (const item of selected) {
    if (item.tier !== "act") continue;
    await appendAction(item, "Queued for immediate execution", config.output.actionLogPath);
    await appendEvent(config.output.eventsPath, {
      plugin: "sapience",
      type: "action_logged",
      domain: item.domain,
      action_class: item.action_class,
      confidence: item.confidence,
    });
  }

  const lead = selected[0]!;
  const result = await enqueueMainSessionInjection(api, buildBatchPrompt(selected));
  if (!result.enqueued) {
    // The sapience-delivery cron drains this queue through cron announce
    // delivery, so a dead injection path degrades to ≤15-minute latency
    // instead of silence. Each item queues on its own, self-contained prompt —
    // the cron composes the message from whatever it finds.
    let queued = true;
    for (const item of selected) {
      if (!(await queueForDeliveryCron(item, config))) queued = false;
    }
    await appendEvent(config.output.eventsPath, {
      plugin: "sapience",
      type: "delivery_failed",
      tier: lead.tier,
      domain: lead.domain,
      items: selected.length,
      reason: result.reason,
      queued,
    });
    return;
  }

  for (const item of selected) {
    // Positive receipt: without it, "queued and waiting for the human's next
    // turn" was indistinguishable from "nothing was ever sent".
    await appendEvent(config.output.eventsPath, {
      plugin: "sapience",
      type: "item_delivered",
      proposal_id: item.id,
      tier: item.tier,
      domain: item.domain,
      priority: item.priority,
    });

    // Initiative: high-priority act/propose items wake the agent to deliver
    // through the last active channel instead of waiting for the user's next
    // turn. Budgeted per local day.
    const state = await readJsonSafe<PushState>(config.output.pushStatePath, { date: "", count: 0 });
    if (shouldPush(item, config.push, state, localDate)) {
      await writeJsonAtomic(config.output.pushStatePath, notePush(state, localDate));
      const requested = requestChannelPush(api, `sapience ${item.tier} (${item.domain})`);
      await appendEvent(config.output.eventsPath, {
        plugin: "sapience",
        type: "push_requested",
        tier: item.tier,
        domain: item.domain,
        priority: item.priority,
        requested,
      });
    }
  }
}

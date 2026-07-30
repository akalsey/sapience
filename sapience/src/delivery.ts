import type { RoutedItem, SapienceConfig } from "./types.js";
import { appendAction } from "./action-log.js";
import { appendEvent } from "./events.js";
import { enqueueMainSessionInjection } from "./main-session.js";
import { addPendingDelivery } from "./pending-deliveries.js";
import { shouldPush, notePush, requestChannelPush, localDateIn, type PushState } from "./push.js";
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
  return USER_FIRST + items.map(tierPromptBody).join("\n\n---\n\n") + OWN_WORDS;
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
  return addPendingDelivery(config.output.pendingDeliveriesPath, {
    id: item.id, kind: "item", prompt: buildTierPrompt(item),
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

  // A routing run can drain a whole backlog of thinking passes (19 in one run
  // the morning after active hours resumed); injecting them all buries the
  // user under a wall of boilerplate in one turn. Take the top few, queue the
  // rest — the delivery cron composes queued items into one concise message.
  // The cap spans the RUN: callers pass every item from every pass they
  // drained, because enforcing it per pass multiplied it by the backlog depth.
  const maxPerCycle = config.delivery?.maxPerCycle ?? 1;
  const selected = sorted.slice(0, maxPerCycle);
  const overflow = sorted.slice(maxPerCycle);
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
    const localDate = localDateIn(config.activeHours.timezone);
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

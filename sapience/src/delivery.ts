import type { RoutedItem, SapienceConfig } from "./types.js";
import { appendAction } from "./action-log.js";
import { appendEvent } from "./events.js";

export function buildTierPrompt(item: RoutedItem): string {
  switch (item.tier) {
    case "act":
      return `[SAPIENCE: ACT] High-confidence action — execute immediately without asking the user for approval, then notify them briefly.

Action: ${item.text}
Domain: ${item.domain} / ${item.action_class}
Confidence: ${(item.confidence * 100).toFixed(0)}%

Execute now. After completion, send a brief message: "I just [what you did]. [Reversible/not reversible]."`;

    case "propose":
      return `[SAPIENCE: PROPOSE] A thinking pass identified this as worth doing. Surface it to the user for approval.

Proposal: ${item.text}
Priority: ${item.priority}/5

Present this concisely and ask if they'd like you to proceed.`;

    case "ask":
      return `[SAPIENCE: ASK] You're capable of this but need information to proceed. Ask the user for exactly what you need.

Action: ${item.text}
Domain: ${item.domain}

State what you can do, then ask the one or two specific questions that would unblock you.`;

    case "explore":
      return `[SAPIENCE: EXPLORE] A problem was identified but the right approach isn't obvious. Present it with options.

Problem: ${item.text}
Priority: ${item.priority}/5

Name the problem, offer 2–3 concrete approaches with their tradeoffs, and ask which fits what they're trying to accomplish.`;

    case "learning":
      return `[SAPIENCE: CALIBRATE] This domain/action class hasn't been calibrated yet. Check with the user before routing.

Item: ${item.text}
Domain: ${item.domain} / ${item.action_class}
Current confidence: ${(item.confidence * 100).toFixed(0)}%

Tell the user: "I noticed [item]. My instinct is to [what you'd do at the propose tier]. Is that the right level of initiative, or would you prefer I handle this differently?"`;
  }
}

export async function deliverItems(
  items: RoutedItem[],
  api: any,
  config: SapienceConfig
): Promise<void> {
  const sorted = [...items].sort((a, b) =>
    (a.tier === "act" ? 0 : 1) - (b.tier === "act" ? 0 : 1)
  );

  for (const item of sorted) {
    if (item.tier === "act") {
      await appendAction(item, "Queued for immediate execution", config.output.actionLogPath);
      await appendEvent(config.output.eventsPath, {
        plugin: "sapience",
        type: "action_logged",
        domain: item.domain,
        action_class: item.action_class,
        confidence: item.confidence,
      });
    }
    await api.session.workflow.enqueueNextTurnInjection({
      sessionTarget: "main",
      text: buildTierPrompt(item),
    });
  }
}

import type { ProposalSet, PluginConfig } from "./types.js";
import { buildHeartbeatPrompt } from "./prompt-builder.js";

export interface HighPriorityItem {
  id: string;
  type: "observation" | "action" | "audit";
  priority: number;
  text: string;
}

export function getHighPriorityProposals(
  proposals: ProposalSet,
  threshold: number,
  maxCount: number
): HighPriorityItem[] {
  const items: HighPriorityItem[] = [
    ...proposals.observations
      .filter((o) => o.priority >= threshold)
      .map((o) => ({ id: o.id, type: "observation" as const, priority: o.priority, text: o.text })),
    ...proposals.proposed_actions
      .filter((a) => a.priority >= threshold)
      .map((a) => ({ id: a.id, type: "action" as const, priority: a.priority, text: a.text })),
    ...proposals.proposed_audits
      .filter((a) => a.priority >= threshold)
      .map((a) => ({ id: a.id, type: "audit" as const, priority: a.priority, text: `${a.domain}: ${a.rationale}` })),
  ];

  return items.sort((a, b) => b.priority - a.priority).slice(0, maxCount);
}

export async function maybeDeliver(
  proposals: ProposalSet,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  config: PluginConfig
): Promise<void> {
  if (!config.delivery.heartbeatTrigger) return;

  const high = getHighPriorityProposals(
    proposals,
    config.delivery.priorityThreshold,
    config.delivery.maxProposalsPerHeartbeat
  );
  if (high.length === 0) return;

  const proposalsList = high
    .map((p) => `- (P${p.priority}) [${p.type}] ${p.text}`)
    .join("\n");

  const heartbeatContent = await buildHeartbeatPrompt(proposalsList);

  // Inject into main session's next turn.
  // NOTE: exact API shape may need adjustment based on installed SDK version.
  await api.session.workflow.enqueueNextTurnInjection({
    content: heartbeatContent,
    sessionTarget: "main",
  });
}

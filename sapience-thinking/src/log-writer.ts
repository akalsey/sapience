import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { ProposalSet } from "./types.js";

export async function appendPass(proposals: ProposalSet, logPath: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });

  const lines: string[] = [`## ${proposals.timestamp} — Pass ${proposals.pass_id}`, ""];
  lines.push(`**Summary:** ${proposals.summary}`, "");

  if (proposals.nothing_to_report) {
    lines.push("**nothing_to_report: true**", "");
  } else {
    if (proposals.observations.length > 0) {
      lines.push("**Observations:**");
      for (const o of proposals.observations) lines.push(`- (P${o.priority}) ${o.text} [${o.id}]`);
      lines.push("");
    }
    if (proposals.proposed_actions.length > 0) {
      lines.push("**Proposed Actions:**");
      for (const a of proposals.proposed_actions) lines.push(`- (P${a.priority}) ${a.text}. Effort: ${a.estimated_effort}. [${a.id}]`);
      lines.push("");
    }
    if (proposals.proposed_audits.length > 0) {
      lines.push("**Proposed Audits:**");
      for (const a of proposals.proposed_audits) lines.push(`- (P${a.priority}) ${a.domain}: ${a.rationale} [${a.id}]`);
      lines.push("");
    }
    if (proposals.open_questions.length > 0) {
      lines.push("**Open Questions:**");
      for (const q of proposals.open_questions) lines.push(`- ${q.text} (blocking: ${q.blocking_what}) [${q.id}]`);
      lines.push("");
    }
  }

  lines.push("---", "");
  await appendFile(logPath, lines.join("\n") + "\n");
}

export async function appendError(passId: string, reason: string, logPath: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  const ts = new Date().toISOString();
  await appendFile(logPath, `## ${ts} — Pass ${passId}\n\n**parse error:** ${reason}\n\n---\n\n`);
}

export async function appendSkipped(reason: string, logPath: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  const ts = new Date().toISOString();
  await appendFile(logPath, `## ${ts} — Skipped: ${reason}\n\n---\n\n`);
}

export async function appendStructuredProposals(proposals: ProposalSet, logPath: string): Promise<void> {
  const jsonlPath = logPath.replace(/\.md$/, ".jsonl");
  await mkdir(dirname(jsonlPath), { recursive: true });
  await appendFile(jsonlPath, JSON.stringify(proposals) + "\n", "utf-8");
}

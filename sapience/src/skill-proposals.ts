import { readFile, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { readJsonSafe, writeJsonAtomic } from "./safe-json.js";

// Skill proposals: multi-step tasks the agent noticed itself doing more than
// once, logged as specs for skills the human may want built. The agent never
// builds or installs these unbidden — the ledger exists to surface the
// pattern, accumulate evidence, and track the human's decision.
//
// Two files: the JSON ledger is machine state (tools update it, thinking
// passes read it, notifications key off it). The markdown is the
// human-readable spec and is APPEND-ONLY — it is never parsed back, reordered,
// or rewritten, so it survives hand edits by the agent or the human.

export type SkillProposalStatus = "proposed" | "building" | "installed" | "declined";

export interface SkillProposal {
  id: string;
  name: string;
  summary: string;
  status: SkillProposalStatus;
  evidence_count: number;
  created_at: string;
  updated_at: string;
}

const MD_HEADER = `# Skill Proposals

Multi-step tasks noticed more than once, logged as specs for skills worth
considering. Nothing here gets built or installed without the human's say-so.

## Proposed Skills
`;

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function loadProposals(jsonPath: string): Promise<SkillProposal[]> {
  const list = await readJsonSafe<SkillProposal[]>(jsonPath, []);
  return Array.isArray(list) ? list : [];
}

async function appendMarkdown(mdPath: string, section: string): Promise<void> {
  let existing: string;
  try { existing = await readFile(mdPath, "utf-8"); } catch { existing = MD_HEADER; }
  await writeFile(mdPath, existing + section, "utf-8");
}

export interface ProposalInput {
  name: string;
  summary: string;
  spec_markdown: string;
}

export async function upsertProposal(
  jsonPath: string,
  mdPath: string,
  input: ProposalInput
): Promise<{ created: boolean; proposal: SkillProposal }> {
  const list = await loadProposals(jsonPath);
  const now = new Date().toISOString();
  const existing = list.find((p) => normalizeName(p.name) === normalizeName(input.name));

  if (existing) {
    existing.evidence_count += 1;
    existing.updated_at = now;
    await writeJsonAtomic(jsonPath, list);
    await appendMarkdown(
      mdPath,
      `\n### ${existing.name} (evidence ×${existing.evidence_count})\n\n${input.spec_markdown.trim()}\n\n_Appended ${now}_\n`
    );
    return { created: false, proposal: existing };
  }

  const proposal: SkillProposal = {
    id: randomUUID().slice(0, 8),
    name: input.name.trim(),
    summary: input.summary.trim(),
    status: "proposed",
    evidence_count: 1,
    created_at: now,
    updated_at: now,
  };
  await writeJsonAtomic(jsonPath, [...list, proposal]);
  await appendMarkdown(
    mdPath,
    `\n### ${proposal.name}\n\n${proposal.summary}\n\n${input.spec_markdown.trim()}\n\n_Logged ${now}_\n`
  );
  return { created: true, proposal };
}

export async function updateProposalStatus(
  jsonPath: string,
  mdPath: string,
  ref: string,
  status: SkillProposalStatus
): Promise<SkillProposal | null> {
  const list = await loadProposals(jsonPath);
  const match = list.find(
    (p) => p.id === ref || normalizeName(p.name) === normalizeName(ref)
  );
  if (!match) return null;

  const now = new Date().toISOString();
  match.status = status;
  match.updated_at = now;
  await writeJsonAtomic(jsonPath, list);
  await appendMarkdown(mdPath, `\n_Status update (${now}): ${match.name} → ${status}_\n`);
  return match;
}

export function renderProposalsList(proposals: SkillProposal[]): string {
  if (proposals.length === 0) return "No skill proposals logged yet.";
  return proposals
    .map((p) => `- [${p.id}] ${p.name} — ${p.summary} (${p.status}, evidence ×${p.evidence_count})`)
    .join("\n");
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  upsertProposal,
  updateProposalStatus,
  loadProposals,
  renderProposalsList,
} from "./skill-proposals.js";

let dir: string;
let jsonPath: string;
let mdPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skill-proposals-"));
  jsonPath = join(dir, "skill-proposals.json");
  mdPath = join(dir, "skill-proposals.md");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const input = {
  name: "Weekly usage divergence analysis",
  summary: "Pull WoW usage by kind, attribute movers, flag anomalies.",
  spec_markdown: "**What it would do:** query sw_daily_usage_type weekly.\n\n**Triggered by:** repeated ad-hoc analyses.",
};

describe("upsertProposal", () => {
  it("creates a ledger entry and appends a spec section to the markdown", async () => {
    const { created, proposal } = await upsertProposal(jsonPath, mdPath, input);
    expect(created).toBe(true);
    expect(proposal.status).toBe("proposed");
    expect(proposal.evidence_count).toBe(1);

    const stored = await loadProposals(jsonPath);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.name).toBe(input.name);

    const md = await readFile(mdPath, "utf-8");
    expect(md).toContain("# Skill Proposals");
    expect(md).toContain(`### ${input.name}`);
    expect(md).toContain("sw_daily_usage_type");
  });

  it("appends evidence to an existing proposal matched by normalized name", async () => {
    await upsertProposal(jsonPath, mdPath, input);
    const { created, proposal } = await upsertProposal(jsonPath, mdPath, {
      ...input,
      name: "  weekly USAGE divergence analysis ",
      spec_markdown: "Second sighting: same analysis for week of 2026-07-20.",
    });
    expect(created).toBe(false);
    expect(proposal.evidence_count).toBe(2);
    expect(await loadProposals(jsonPath)).toHaveLength(1);

    const md = await readFile(mdPath, "utf-8");
    expect(md).toContain("Second sighting");
    expect(md).toContain("evidence ×2");
  });

  it("preserves an existing hand-written markdown file by appending only", async () => {
    // Poppy already has a skill-proposals.md the human reads; the feature must
    // never rewrite or reorder what is there.
    const { writeFile } = await import("fs/promises");
    await writeFile(mdPath, "# Skill Proposals\n\nhand-written preamble\n");
    await upsertProposal(jsonPath, mdPath, input);
    const md = await readFile(mdPath, "utf-8");
    expect(md.startsWith("# Skill Proposals\n\nhand-written preamble\n")).toBe(true);
    expect(md).toContain(`### ${input.name}`);
  });
});

describe("updateProposalStatus", () => {
  it("transitions status by exact name and appends a dated note to the markdown", async () => {
    await upsertProposal(jsonPath, mdPath, input);
    const updated = await updateProposalStatus(jsonPath, mdPath, input.name, "installed");
    expect(updated?.status).toBe("installed");

    const stored = await loadProposals(jsonPath);
    expect(stored[0]!.status).toBe("installed");

    const md = await readFile(mdPath, "utf-8");
    expect(md).toMatch(/Status update .*installed/);
  });

  it("transitions status by id", async () => {
    const { proposal } = await upsertProposal(jsonPath, mdPath, input);
    const updated = await updateProposalStatus(jsonPath, mdPath, proposal.id, "declined");
    expect(updated?.status).toBe("declined");
  });

  it("returns null for an unknown proposal", async () => {
    expect(await updateProposalStatus(jsonPath, mdPath, "nope", "installed")).toBeNull();
  });
});

describe("renderProposalsList", () => {
  it("lists open proposals with id, status, and evidence count", async () => {
    const { proposal } = await upsertProposal(jsonPath, mdPath, input);
    await upsertProposal(jsonPath, mdPath, input); // second sighting
    const text = renderProposalsList(await loadProposals(jsonPath));
    expect(text).toContain(proposal.id);
    expect(text).toContain("proposed");
    expect(text).toContain("×2");
  });

  it("says so when there are none", () => {
    expect(renderProposalsList([])).toContain("No skill proposals");
  });
});

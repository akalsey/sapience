import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseSkillFrontmatter,
  discoverInstalledSkills,
  findOverlappingSkills,
  checkAgainstInstalledSkills,
  resolveSkillDirs,
  skillSlug,
  type InstalledSkill,
} from "./installed-skills.js";

let dir: string;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "installed-skills-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function writeSkill(root: string, name: string, frontmatter: string, body = "# body\n"): Promise<void> {
  const skillDir = join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`, "utf-8");
}

describe("parseSkillFrontmatter", () => {
  it("reads name and description", () => {
    const fm = parseSkillFrontmatter("---\nname: pdf\ndescription: Work with PDF files.\n---\n\n# PDF\n");
    expect(fm).toEqual({ name: "pdf", description: "Work with PDF files." });
  });

  it("joins indented continuation lines and strips quotes and block markers", () => {
    const fm = parseSkillFrontmatter(
      "---\nname: \"weekly-usage\"\ndescription: >\n  Pull week-over-week usage\n  and attribute the movers.\n---\n"
    );
    expect(fm.name).toBe("weekly-usage");
    expect(fm.description).toBe("Pull week-over-week usage and attribute the movers.");
  });

  it("returns nothing for a file without frontmatter", () => {
    expect(parseSkillFrontmatter("# just a heading\n")).toEqual({});
    expect(parseSkillFrontmatter("---\nname: unterminated\n")).toEqual({});
  });
});

describe("discoverInstalledSkills", () => {
  it("finds skills across roots, nested packs included", async () => {
    const workspace = join(dir, "workspace", "skills");
    const global = join(dir, "state", "skills");
    await writeSkill(workspace, "goal-abc12345", "name: goal-abc12345\ndescription: Standing instructions.");
    await writeSkill(global, "pdf", "name: pdf\ndescription: Work with PDF files.");
    await writeSkill(join(global, "signalwire-pack"), "slides", "name: signalwire-slides\ndescription: On-brand slides.");

    const found = await discoverInstalledSkills([workspace, global, join(dir, "does-not-exist")]);
    expect(found.map((s) => s.name).sort()).toEqual(["goal-abc12345", "pdf", "signalwire-slides"]);
  });

  it("falls back to the directory name when frontmatter has none", async () => {
    const root = join(dir, "skills");
    await mkdir(join(root, "orphan"), { recursive: true });
    await writeFile(join(root, "orphan", "SKILL.md"), "# no frontmatter\n", "utf-8");
    const [found] = await discoverInstalledSkills([root]);
    expect(found).toMatchObject({ name: "orphan", description: "" });
  });

  it("ignores dotfiles and directories with no SKILL.md, and tolerates a missing root", async () => {
    const root = join(dir, "skills");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "README.md"), "not a skill", "utf-8");
    expect(await discoverInstalledSkills([root])).toEqual([]);
    expect(await discoverInstalledSkills([join(dir, "nope")])).toEqual([]);
  });

  it("reports a skill once when two roots see the same one", async () => {
    const global = join(dir, "state", "skills");
    await writeSkill(global, "pdf", "name: pdf\ndescription: Work with PDF files.");
    const workspace = join(dir, "workspace", "skills");
    await mkdir(workspace, { recursive: true });
    await symlink(join(global, "pdf"), join(workspace, "pdf"), "dir");

    const found = await discoverInstalledSkills([workspace, global]);
    expect(found).toHaveLength(1);
  });
});

describe("resolveSkillDirs", () => {
  it("includes the workspace and state skill roots plus configured extras", () => {
    const dirs = resolveSkillDirs(
      { runtime: { state: { resolveStateDir: () => "/state" } } },
      "/workspace",
      ["/extra/skills"]
    );
    expect(dirs).toContain("/workspace/skills");
    expect(dirs).toContain("/state/skills");
    expect(dirs).toContain("/extra/skills");
  });

  it("falls back to ~/.openclaw when the runtime can't say", () => {
    expect(resolveSkillDirs({}, "/workspace").length).toBeGreaterThan(0);
    expect(resolveSkillDirs({ runtime: { state: { resolveStateDir: () => { throw new Error("nope"); } } } }, "/w"))
      .toContain("/w/skills");
  });
});

describe("skillSlug", () => {
  it("normalizes spacing, case, and separators", () => {
    expect(skillSlug("  Weekly Usage Divergence ")).toBe("weekly-usage-divergence");
    expect(skillSlug("weekly_usage_divergence")).toBe("weekly-usage-divergence");
  });
});

const SKILLS: InstalledSkill[] = [
  {
    name: "avoid-ai-writing",
    description:
      "Audit and rewrite content to remove AI writing patterns (AI-isms). Covers vocabulary, formatting, rhythm, and rhetorical tics.",
    path: "/skills/avoid-ai-writing/SKILL.md",
  },
  {
    name: "pdf",
    description: "Read, extract, merge, split, and fill PDF files.",
    path: "/skills/pdf/SKILL.md",
  },
];

describe("findOverlappingSkills", () => {
  it("matches an installed skill by name regardless of wording", () => {
    const [hit] = findOverlappingSkills(SKILLS, "Avoid AI Writing", "Something else entirely, honest.");
    expect(hit).toMatchObject({ sameName: true, score: 1 });
    expect(hit!.skill.name).toBe("avoid-ai-writing");
  });

  it("matches a differently-named skill that does the same job", () => {
    const hits = findOverlappingSkills(
      SKILLS,
      "ai-isms-cleanup",
      "Audit drafts for AI writing patterns and rewrite the vocabulary and rhythm."
    );
    expect(hits.map((h) => h.skill.name)).toContain("avoid-ai-writing");
  });

  it("never blocks on sapience-goals' temporary goal skills", () => {
    const goalSkill: InstalledSkill = {
      name: "goal-abc12345",
      description: "Standing instructions for the goal \"cut PDF turnaround\" — temporary, managed by sapience-goals.",
      path: "/skills/goal-abc12345/SKILL.md",
    };
    expect(findOverlappingSkills([goalSkill], "goal-abc12345", "Anything at all.")).toEqual([]);
  });

  it("does not flag unrelated work", () => {
    expect(findOverlappingSkills(
      SKILLS,
      "weekly-usage-divergence",
      "Query week-over-week usage by product kind and attribute the movers."
    )).toEqual([]);
  });
});

describe("checkAgainstInstalledSkills", () => {
  it("lets a genuinely new proposal through", () => {
    const verdict = checkAgainstInstalledSkills(
      SKILLS,
      "weekly-usage-divergence",
      "Query week-over-week usage by product kind and attribute the movers."
    );
    expect(verdict.blocked).toBe(false);
  });

  it("refuses a same-named skill outright, justification or not", () => {
    const verdict = checkAgainstInstalledSkills(
      SKILLS, "pdf", "Merge and split PDF files.", "the installed one is different, trust me"
    );
    expect(verdict).toMatchObject({ blocked: true, reason: "same_name" });
    if (verdict.blocked) {
      expect(verdict.matched.name).toBe("pdf");
      expect(verdict.message).toContain("already installed");
    }
  });

  it("refuses an unjustified overlap and names the skill to read", () => {
    const verdict = checkAgainstInstalledSkills(
      SKILLS, "ai-isms-cleanup", "Audit drafts for AI writing patterns and rewrite the vocabulary and rhythm."
    );
    expect(verdict).toMatchObject({ blocked: true, reason: "unjustified_overlap" });
    if (verdict.blocked) {
      expect(verdict.message).toContain("avoid-ai-writing");
      expect(verdict.message).toContain("not_covered_by");
    }
  });

  it("allows the overlap through once the caller says what isn't covered", () => {
    const verdict = checkAgainstInstalledSkills(
      SKILLS,
      "ai-isms-cleanup",
      "Audit drafts for AI writing patterns and rewrite the vocabulary and rhythm.",
      "avoid-ai-writing audits prose; this one has to run over the docs site's MDX build output."
    );
    expect(verdict.blocked).toBe(false);
  });

  it("has nothing to say when no skills are installed", () => {
    expect(checkAgainstInstalledSkills([], "anything", "does a thing").blocked).toBe(false);
  });
});

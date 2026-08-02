import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseSkillFrontmatter,
  discoverInstalledSkills,
  resolveSkillDirs,
  buildInstalledSkillsContext,
} from "./installed-skills.js";

let dir: string;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "thinking-skills-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function writeSkill(root: string, name: string, frontmatter: string): Promise<void> {
  const skillDir = join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# body\n`, "utf-8");
}

describe("parseSkillFrontmatter", () => {
  it("reads name and description, folded lines included", () => {
    expect(parseSkillFrontmatter("---\nname: pdf\ndescription: Work with PDFs.\n---\n"))
      .toEqual({ name: "pdf", description: "Work with PDFs." });
    expect(parseSkillFrontmatter("---\nname: x\ndescription: >\n  one\n  two\n---\n").description)
      .toBe("one two");
  });
});

describe("discoverInstalledSkills", () => {
  it("reads skills from every root, nested packs included, missing roots tolerated", async () => {
    const workspace = join(dir, "workspace", "skills");
    const global = join(dir, "state", "skills");
    await writeSkill(workspace, "usage-report", "name: usage-report\ndescription: Weekly usage rollup.");
    await writeSkill(join(global, "pack"), "pdf", "name: pdf\ndescription: Work with PDFs.");

    const found = await discoverInstalledSkills([workspace, global, join(dir, "absent")]);
    expect(found.map((s) => s.name).sort()).toEqual(["pdf", "usage-report"]);
  });
});

describe("resolveSkillDirs", () => {
  it("covers workspace and state roots plus configured extras", () => {
    const dirs = resolveSkillDirs(
      { runtime: { state: { resolveStateDir: () => "/state" } } }, "/workspace", ["/extra"]
    );
    expect(dirs).toEqual(expect.arrayContaining(["/workspace/skills", "/state/skills", "/extra"]));
  });
});

describe("buildInstalledSkillsContext", () => {
  const skill = (name: string, description = "") => ({ name, description, path: `/skills/${name}/SKILL.md` });

  it("renders name and description per skill", () => {
    const text = buildInstalledSkillsContext([skill("pdf", "Work with PDF files.")]);
    expect(text).toBe("- pdf — Work with PDF files.");
  });

  it("truncates long descriptions", () => {
    const text = buildInstalledSkillsContext([skill("verbose", "x".repeat(400))]);
    expect(text.length).toBeLessThan(220);
    expect(text).toContain("…");
  });

  it("leaves out sapience-goals' temporary goal skills", () => {
    expect(buildInstalledSkillsContext([skill("goal-abc12345", "Standing instructions.")])).toBe("");
  });

  it("is empty when nothing is installed", () => {
    expect(buildInstalledSkillsContext([])).toBe("");
  });
});

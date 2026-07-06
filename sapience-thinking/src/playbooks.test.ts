import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { BUILTIN_PLAYBOOKS, loadPlaybooks, addPlaybook, renderPlaybooks } from "./playbooks.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "playbooks-"));
  path = join(dir, "playbooks.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("BUILTIN_PLAYBOOKS", () => {
  it("includes the core analyst moves", () => {
    const ids = BUILTIN_PLAYBOOKS.map((p) => p.id);
    expect(ids).toContain("decompose-on-delta");
    expect(ids).toContain("case-to-cohort");
    for (const p of BUILTIN_PLAYBOOKS) {
      expect(p.instruction.length).toBeGreaterThan(20);
    }
  });
});

describe("loadPlaybooks", () => {
  it("returns builtins when no user file exists", async () => {
    const all = await loadPlaybooks(path);
    expect(all.length).toBe(BUILTIN_PLAYBOOKS.length);
  });

  it("merges user playbooks after builtins", async () => {
    await writeFile(path, JSON.stringify([
      { id: "churn-segment", title: "Churn segmentation", instruction: "Whenever you look at churn, segment by plan tier.", source: "feedback", added_at: "2026-07-01T00:00:00Z" },
    ]));
    const all = await loadPlaybooks(path);
    expect(all.length).toBe(BUILTIN_PLAYBOOKS.length + 1);
    expect(all[all.length - 1]!.id).toBe("churn-segment");
  });
});

describe("addPlaybook", () => {
  it("appends a taught playbook and survives reload", async () => {
    const added = await addPlaybook(path, "Whenever you look at churn, segment by plan tier.");
    expect(added).not.toBeNull();
    const stored = JSON.parse(await readFile(path, "utf-8"));
    expect(stored).toHaveLength(1);
    expect(stored[0].source).toBe("feedback");
    const all = await loadPlaybooks(path);
    expect(all.some((p) => p.instruction.includes("segment by plan tier"))).toBe(true);
  });

  it("does not add the same instruction twice", async () => {
    await addPlaybook(path, "Whenever you look at churn, segment by plan tier.");
    const second = await addPlaybook(path, "whenever you look at churn, segment by plan tier.");
    expect(second).toBeNull();
    expect(JSON.parse(await readFile(path, "utf-8"))).toHaveLength(1);
  });
});

describe("renderPlaybooks", () => {
  it("renders instructions as a list", () => {
    const text = renderPlaybooks(BUILTIN_PLAYBOOKS.slice(0, 2));
    expect(text).toContain(BUILTIN_PLAYBOOKS[0]!.instruction);
    expect(text).toContain(BUILTIN_PLAYBOOKS[1]!.instruction);
  });
});

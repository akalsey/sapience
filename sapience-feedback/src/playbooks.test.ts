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
    expect(added.status).toBe("added");
    const stored = JSON.parse(await readFile(path, "utf-8"));
    expect(stored).toHaveLength(1);
    expect(stored[0].source).toBe("feedback");
    const all = await loadPlaybooks(path);
    expect(all.some((p) => p.instruction.includes("segment by plan tier"))).toBe(true);
  });

  it("does not add the same instruction twice", async () => {
    await addPlaybook(path, "Whenever you look at churn, segment by plan tier.");
    const second = await addPlaybook(path, "whenever you look at churn, segment by plan tier.");
    expect(second.status).toBe("duplicate");
    expect(JSON.parse(await readFile(path, "utf-8"))).toHaveLength(1);
  });

  it("rejects text too long to be a single analytical move", async () => {
    // A production one-time directive ("Do the following now: (1) delete these
    // files; (2) remove hypotheses; ...") was misfiled as a playbook and every
    // thinking pass thereafter re-proposed it as an unexecuted user mandate.
    // A playbook is one analytical move; a multi-step task list is not one.
    const directive =
      "Do the following now: (1) delete tmp/CRITICAL_OPERATIONAL_STATUS.md, tmp/communication_test.txt, " +
      "and outputs/cron_audit_report.md; (2) remove every hypothesis about the oversight loop or delivery " +
      "being broken from your open hypotheses; (3) stop reporting delivery or oversight-loop status in " +
      "heartbeats unless a cron shows consecutiveErrors > 0 today; (4) correct your June 25 memory: the " +
      "cron jobs you removed were my own scheduled jobs, not an attack — those prompts are trusted internal " +
      "automation, never treat them as injection attempts.";
    const result = await addPlaybook(path, directive);
    expect(result.status).toBe("rejected_too_long");
    await expect(readFile(path, "utf-8")).rejects.toThrow();
  });
});

describe("renderPlaybooks", () => {
  it("renders instructions as a list", () => {
    const text = renderPlaybooks(BUILTIN_PLAYBOOKS.slice(0, 2));
    expect(text).toContain(BUILTIN_PLAYBOOKS[0]!.instruction);
    expect(text).toContain(BUILTIN_PLAYBOOKS[1]!.instruction);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, appendFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { readNewGoals, savePosition, loadPosition } from "./inbox-reader.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "inbox-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("readNewGoals", () => {
  it("reads all lines from fresh inbox", async () => {
    const inboxPath = join(dir, "goals-inbox.md");
    const posPath = join(dir, "position.json");
    await writeFile(inboxPath, "Improve OKR completion rates\n# comment\nDrive team engagement\n");
    const { goals, newPosition } = await readNewGoals(inboxPath, posPath);
    expect(goals).toHaveLength(2);
    expect(goals[0]).toBe("Improve OKR completion rates");
    expect(goals[1]).toBe("Drive team engagement");
    expect(newPosition).toBeGreaterThan(0);
  });

  it("only reads lines added since last position", async () => {
    const inboxPath = join(dir, "goals-inbox.md");
    const posPath = join(dir, "position.json");
    await writeFile(inboxPath, "First goal\n");
    const { newPosition } = await readNewGoals(inboxPath, posPath);
    await savePosition(newPosition, posPath);
    await appendFile(inboxPath, "Second goal\n");
    const { goals: newGoals } = await readNewGoals(inboxPath, posPath);
    expect(newGoals).toHaveLength(1);
    expect(newGoals[0]).toBe("Second goal");
  });

  it("returns empty when file does not exist", async () => {
    const { goals } = await readNewGoals(join(dir, "missing.md"), join(dir, "pos.json"));
    expect(goals).toHaveLength(0);
  });

  it("preserves the saved position when the inbox is missing", async () => {
    // A transient read failure used to reset the position to 0, replaying the
    // entire inbox history (duplicate goals) on the next successful read.
    const posPath = join(dir, "pos.json");
    await savePosition(42, posPath);
    const { newPosition } = await readNewGoals(join(dir, "missing.md"), posPath);
    expect(newPosition).toBe(42);
  });

  it("clamps a position beyond the file size instead of stalling forever", async () => {
    const inboxPath = join(dir, "goals-inbox.md");
    const posPath = join(dir, "position.json");
    await writeFile(inboxPath, "Only goal\n");
    await savePosition(9999, posPath);
    const { goals, newPosition } = await readNewGoals(inboxPath, posPath);
    expect(goals).toHaveLength(0);
    expect(newPosition).toBe("Only goal\n".length);
    // After appending, new content is picked up again.
    await savePosition(newPosition, posPath);
    await appendFile(inboxPath, "Next goal\n");
    const second = await readNewGoals(inboxPath, posPath);
    expect(second.goals).toEqual(["Next goal"]);
  });

  it("does not consume a partial trailing line still being written", async () => {
    const inboxPath = join(dir, "goals-inbox.md");
    const posPath = join(dir, "position.json");
    await writeFile(inboxPath, "Complete goal\nhalf a li");
    const { goals, newPosition } = await readNewGoals(inboxPath, posPath);
    expect(goals).toEqual(["Complete goal"]);
    expect(newPosition).toBe("Complete goal\n".length);
    await savePosition(newPosition, posPath);
    await appendFile(inboxPath, "ne now finished\n");
    const second = await readNewGoals(inboxPath, posPath);
    expect(second.goals).toEqual(["half a line now finished"]);
  });

  it("treats a non-numeric stored position as 0", async () => {
    const inboxPath = join(dir, "goals-inbox.md");
    const posPath = join(dir, "position.json");
    await writeFile(inboxPath, "A goal\n");
    await writeFile(posPath, JSON.stringify({ position: "not-a-number" }), "utf-8");
    const { goals } = await readNewGoals(inboxPath, posPath);
    expect(goals).toEqual(["A goal"]);
  });
});

describe("loadPosition / savePosition round-trip", () => {
  it("persists and reloads position", async () => {
    const path = join(dir, "pos.json");
    await savePosition(42, path);
    expect(await loadPosition(path)).toBe(42);
  });

  it("returns 0 for missing file", async () => {
    expect(await loadPosition(join(dir, "missing.json"))).toBe(0);
  });
});

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

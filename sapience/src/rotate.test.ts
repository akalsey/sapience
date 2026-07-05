import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm, access } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { rotateKeepingTail } from "./rotate.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rotate-"));
  file = join(dir, "log.jsonl");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix}-${i}`).join("\n") + "\n";

describe("rotateKeepingTail", () => {
  it("does nothing below the size threshold", async () => {
    await writeFile(file, lines(10));
    expect(await rotateKeepingTail(file, { maxBytes: 10_000 })).toBe(false);
    expect(await readFile(file, "utf-8")).toBe(lines(10));
  });

  it("keeps the newest lines in place and archives the previous contents once", async () => {
    await writeFile(file, lines(100));
    const rotated = await rotateKeepingTail(file, { maxBytes: 100, keepLines: 10 });
    expect(rotated).toBe(true);
    const kept = (await readFile(file, "utf-8")).trim().split("\n");
    expect(kept).toHaveLength(10);
    expect(kept[9]).toBe("line-99");
    expect(kept[0]).toBe("line-90");
    // Full previous contents are in the single .old archive.
    expect(await readFile(`${file}.old`, "utf-8")).toBe(lines(100));
  });

  it("replaces the previous archive instead of accumulating (bounded disk)", async () => {
    await writeFile(file, lines(100, "first"));
    await rotateKeepingTail(file, { maxBytes: 100, keepLines: 5 });
    await writeFile(file, lines(100, "second"));
    await rotateKeepingTail(file, { maxBytes: 100, keepLines: 5 });
    const archive = await readFile(`${file}.old`, "utf-8");
    expect(archive).toContain("second-0");
    expect(archive).not.toContain("first-0");
  });

  it("tolerates a missing file", async () => {
    expect(await rotateKeepingTail(join(dir, "nope.log"))).toBe(false);
    await expect(access(`${join(dir, "nope.log")}.old`)).rejects.toThrow();
  });
});

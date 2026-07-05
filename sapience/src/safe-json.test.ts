import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { writeJsonAtomic, readJsonSafe } from "./safe-json.js";

let tmpDir: string;
let file: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "safe-json-"));
  file = join(tmpDir, "nested", "state.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  it("round-trips a value, creating parent dirs", async () => {
    await writeJsonAtomic(file, { a: 1 });
    expect(await readJsonSafe(file, null)).toEqual({ a: 1 });
  });

  it("leaves no temp files behind", async () => {
    await writeJsonAtomic(file, [1, 2, 3]);
    const entries = await readdir(join(tmpDir, "nested"));
    expect(entries).toEqual(["state.json"]);
  });

  it("replaces existing content completely", async () => {
    await writeJsonAtomic(file, { a: 1, b: 2 });
    await writeJsonAtomic(file, { c: 3 });
    expect(await readJsonSafe(file, null)).toEqual({ c: 3 });
  });
});

describe("readJsonSafe", () => {
  it("returns the fallback for a missing file", async () => {
    expect(await readJsonSafe(file, [])).toEqual([]);
  });

  it("quarantines a corrupt file instead of silently discarding it", async () => {
    await writeJsonAtomic(file, { keep: "me" });
    await writeFile(file, '{"keep": "me', "utf-8"); // truncated mid-write
    expect(await readJsonSafe(file, "fallback")).toBe("fallback");

    const entries = await readdir(join(tmpDir, "nested"));
    const quarantined = entries.find((e) => e.startsWith("state.json.corrupt-"));
    expect(quarantined).toBeDefined();
    expect(await readFile(join(tmpDir, "nested", quarantined!), "utf-8")).toBe('{"keep": "me');
    // The original path is now clear: a subsequent save cannot overwrite the evidence.
    expect(entries).not.toContain("state.json");
  });

  it("reads intact JSON normally", async () => {
    await writeFile(join(tmpDir, "nested", "..", "flat.json"), "[1,2]", "utf-8").catch(() => {});
    await writeJsonAtomic(file, [1, 2]);
    expect(await readJsonSafe(file, [])).toEqual([1, 2]);
  });
});

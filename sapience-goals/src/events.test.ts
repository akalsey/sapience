import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { appendEvent } from "./events.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "events-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("appendEvent", () => {
  it("appends one JSON line and sets ts", async () => {
    const path = join(dir, "sub", "events.jsonl");
    await appendEvent(path, { plugin: "sapience", type: "routing_completed", items: 3 });
    const lines = (await readFile(path, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]!);
    expect(ev.plugin).toBe("sapience");
    expect(ev.type).toBe("routing_completed");
    expect(ev.items).toBe(3);
    expect(new Date(ev.ts).getTime()).not.toBeNaN();
  });

  it("preserves an explicit ts", async () => {
    const path = join(dir, "events.jsonl");
    await appendEvent(path, { ts: "2026-01-01T00:00:00.000Z", plugin: "goals", type: "goal_created" });
    const ev = JSON.parse((await readFile(path, "utf-8")).trim());
    expect(ev.ts).toBe("2026-01-01T00:00:00.000Z");
  });

  it("appends successive events as separate lines", async () => {
    const path = join(dir, "events.jsonl");
    await appendEvent(path, { plugin: "thinking", type: "pass_skipped" });
    await appendEvent(path, { plugin: "thinking", type: "pass_completed" });
    expect((await readFile(path, "utf-8")).trim().split("\n")).toHaveLength(2);
  });

  it("swallows errors instead of throwing", async () => {
    const path = join(dir, "isdir");
    await mkdir(path); // eventsPath is a directory -> appendFile fails
    await expect(
      appendEvent(path, { plugin: "feedback", type: "signal_detected" })
    ).resolves.toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  readEntry, writeEntry, deleteEntry,
  listEntryFilenames, loadAllEntries,
} from "./storage.js";
import type { MemoryEntry } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const entry: MemoryEntry = {
  id: "mem_2026-05-20_a3f9b2c1",
  created: "2026-05-20T14:30:00Z",
  updated: "2026-05-20T14:30:00Z",
  tags: ["posthog", "billing"],
  source: "session",
  score: 0.7,
  size_tier: "full",
  last_accessed: "2026-05-20T14:30:00Z",
  access_count: 0,
  title: "PostHog Billing",
  body: "# PostHog Billing\n\nBody text here.",
  filename: "2026-05-20-posthog-billing-a3f9b2c1.md",
};

describe("writeEntry + readEntry round-trip", () => {
  it("writes and reads back the same entry", async () => {
    await writeEntry(dir, entry);
    const loaded = await readEntry(dir, entry.filename);
    expect(loaded.id).toBe(entry.id);
    expect(loaded.tags).toEqual(entry.tags);
    expect(loaded.access_count).toBe(0);
  });
});

describe("deleteEntry", () => {
  it("removes the file", async () => {
    await writeEntry(dir, entry);
    await deleteEntry(dir, entry.filename);
    const files = await listEntryFilenames(dir);
    expect(files).toHaveLength(0);
  });
});

describe("listEntryFilenames", () => {
  it("returns valid memory filenames only, sorted", async () => {
    await writeFile(join(dir, "2026-05-20-foo-11111111.md"), "---\n---\n");
    await writeFile(join(dir, "2026-05-19-bar-22222222.md"), "---\n---\n");
    await writeFile(join(dir, "not-a-memory.txt"), "ignored");
    await writeFile(join(dir, "invalid-format.md"), "ignored");
    const files = await listEntryFilenames(dir);
    expect(files).toEqual(["2026-05-19-bar-22222222.md", "2026-05-20-foo-11111111.md"]);
  });

  it("returns empty array when directory does not exist", async () => {
    const files = await listEntryFilenames(join(dir, "nonexistent"));
    expect(files).toHaveLength(0);
  });
});

describe("loadAllEntries", () => {
  it("loads all entries from directory", async () => {
    await writeEntry(dir, entry);
    await writeEntry(dir, { ...entry, id: "mem_2026-05-21_b4f8c2d0", filename: "2026-05-21-posthog-billing-b4f8c2d0.md" });
    const all = await loadAllEntries(dir);
    expect(all).toHaveLength(2);
  });

  it("returns empty array for empty directory", async () => {
    expect(await loadAllEntries(dir)).toHaveLength(0);
  });
});

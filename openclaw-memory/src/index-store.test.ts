import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { writeEntry } from "./storage.js";
import { IndexStore } from "./index-store.js";
import type { MemoryEntry } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "idx-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const entry: MemoryEntry = {
  id: "mem_2026-05-20_a3f9b2c1",
  created: "2026-05-20T14:30:00Z",
  updated: "2026-05-20T14:30:00Z",
  tags: ["posthog"],
  source: "session",
  score: 0.7,
  size_tier: "full",
  last_accessed: "2026-05-20T14:30:00Z",
  access_count: 0,
  title: "PostHog Billing",
  body: "# PostHog Billing\n\nBilling spike from groupIdentify.",
  filename: "2026-05-20-posthog-billing-a3f9b2c1.md",
};

describe("loadFromDirectory", () => {
  it("starts empty for empty directory", async () => {
    const store = new IndexStore();
    await store.loadFromDirectory(dir);
    expect(store.size()).toBe(0);
  });

  it("loads existing entries from disk", async () => {
    await writeEntry(dir, entry);
    const store = new IndexStore();
    await store.loadFromDirectory(dir);
    expect(store.size()).toBe(1);
    expect(store.getById(entry.id)?.title).toBe("PostHog Billing");
  });
});

describe("add", () => {
  it("makes entry retrievable by id", () => {
    const store = new IndexStore();
    store.add(entry);
    expect(store.getById(entry.id)).toBeDefined();
    expect(store.size()).toBe(1);
  });

  it("makes entry findable via search", () => {
    const store = new IndexStore();
    store.add(entry);
    const { results } = store.search({ query: "billing spike" }, 30, 1.2, 5, 20);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("update", () => {
  it("replaces existing entry", () => {
    const store = new IndexStore();
    store.add(entry);
    store.update({ ...entry, title: "Updated Title", body: "# Updated Title\n\nNew content." });
    expect(store.getById(entry.id)?.title).toBe("Updated Title");
    expect(store.size()).toBe(1);
  });
});

describe("removeById", () => {
  it("removes the entry", () => {
    const store = new IndexStore();
    store.add(entry);
    store.removeById(entry.id);
    expect(store.getById(entry.id)).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});

describe("removeByFilename", () => {
  it("removes entry matching the filename", () => {
    const store = new IndexStore();
    store.add(entry);
    store.removeByFilename(entry.filename);
    expect(store.size()).toBe(0);
  });
});

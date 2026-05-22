import { describe, it, expect } from "vitest";
import { resolvePath, generateId, slugify, generateFilename, extractTitle, MEMORY_FILENAME_PATTERN } from "./utils.js";
import { homedir } from "os";
import { join } from "path";

describe("resolvePath", () => {
  it("expands tilde", () => {
    expect(resolvePath("~/.openclaw/memory")).toBe(join(homedir(), ".openclaw/memory"));
  });
  it("leaves absolute paths unchanged", () => {
    expect(resolvePath("/tmp/foo")).toBe("/tmp/foo");
  });
});

describe("generateId", () => {
  it("matches mem_YYYY-MM-DD_XXXX format", () => {
    expect(generateId()).toMatch(/^mem_\d{4}-\d{2}-\d{2}_[0-9a-f]{8}$/);
  });
  it("is unique on repeated calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateId()));
    expect(ids.size).toBeGreaterThan(15);
  });
});

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("PostHog Billing Investigation")).toBe("posthog-billing-investigation");
  });
  it("removes non-word characters", () => {
    expect(slugify("fix (the) issue!")).toBe("fix-the-issue");
  });
  it("truncates to 60 chars", () => {
    expect(slugify("a".repeat(100))).toHaveLength(60);
  });
});

describe("generateFilename", () => {
  it("includes date, slug, and id suffix", () => {
    const id = "mem_2026-05-21_a3f9b2c1";
    const filename = generateFilename(id, "PostHog billing", new Date("2026-05-21"));
    expect(filename).toMatch(/^2026-05-21-posthog-billing-a3f9b2c1\.md$/);
  });
});

describe("extractTitle", () => {
  it("extracts first H1 heading", () => {
    expect(extractTitle("# My Title\n\nBody text", "fallback")).toBe("My Title");
  });
  it("returns fallback when no H1 present", () => {
    expect(extractTitle("Just some body text", "fallback")).toBe("fallback");
  });
});

describe("MEMORY_FILENAME_PATTERN", () => {
  it("matches valid memory filenames", () => {
    expect(MEMORY_FILENAME_PATTERN.test("2026-05-21-posthog-billing-a3f9b2c1.md")).toBe(true);
  });
  it("rejects filenames without date prefix", () => {
    expect(MEMORY_FILENAME_PATTERN.test("posthog-billing.md")).toBe(false);
  });
  it("rejects non-md extensions", () => {
    expect(MEMORY_FILENAME_PATTERN.test("2026-05-21-posthog-billing-a3f9b2c1.txt")).toBe(false);
  });
});

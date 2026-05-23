import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { appendFeedback } from "./log-writer.js";
import type { FeedbackEntry } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "feedback-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const entry: FeedbackEntry = {
  id: "fb-001",
  detected_at: "2026-05-20T14:30:00Z",
  signal: {
    type: "correction",
    domain: "slides",
    action_class: "format_choice",
    message: "use the company template",
    raw_text: "use the company template not the default",
  },
  meta_pointer: "Before creating slides: check feedback log for template corrections",
};

describe("appendFeedback", () => {
  it("writes markdown entry to log", async () => {
    const path = join(dir, "feedback.md");
    await appendFeedback(entry, path);
    const content = await readFile(path, "utf-8");
    expect(content).toContain("correction");
    expect(content).toContain("slides");
    expect(content).toContain("Before creating slides");
  });

  it("creates parent directories", async () => {
    const path = join(dir, "sub", "feedback.md");
    await expect(appendFeedback(entry, path)).resolves.not.toThrow();
  });
});

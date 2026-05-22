import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { buildContextFromDirs, getLastThreePasses } from "./context-builder.js";
import type { PluginConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

let tmpDir: string;

const config: PluginConfig = {
  ...DEFAULT_CONFIG,
  context: { lookbackHours: 24, maxContextTokens: 8000 },
};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ctx-builder-test-"));
});

afterEach(async () => { await rm(tmpDir, { recursive: true }); });

describe("buildContextFromDirs", () => {
  it("returns empty context when session dir does not exist", async () => {
    const bundle = await buildContextFromDirs(config, join(tmpDir, "sessions"), join(tmpDir, "memory"));
    expect(bundle.recentActivity).toContain("No recent session activity");
  });

  it("reads JSONL session files and extracts messages", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const entry = JSON.stringify({ role: "user", content: "What is the plan?" });
    await writeFile(join(sessionDir, "session1.jsonl"), entry + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, join(tmpDir, "memory"));
    expect(bundle.recentActivity).toContain("What is the plan?");
  });

  it("skips malformed JSONL lines without crashing", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session1.jsonl"), "not-json\n" + JSON.stringify({ role: "user", content: "hello" }) + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, join(tmpDir, "memory"));
    expect(bundle.recentActivity).toContain("hello");
  });

  it("trims content to stay within maxContextTokens", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const bigMessage = "x".repeat(100000);
    await writeFile(join(sessionDir, "session1.jsonl"), JSON.stringify({ role: "user", content: bigMessage }) + "\n");

    const smallConfig = { ...config, context: { lookbackHours: 24, maxContextTokens: 100 } };
    const bundle = await buildContextFromDirs(smallConfig, sessionDir, join(tmpDir, "memory"));
    expect(bundle.tokenEstimate).toBeLessThanOrEqual(150);
  });

  it("includes memory files when present", async () => {
    const sessionDir = join(tmpDir, "sessions");
    const memoryDir = join(tmpDir, "memory");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "fact.md"), "User is a data scientist.\n");

    const bundle = await buildContextFromDirs(config, sessionDir, memoryDir);
    expect(bundle.recentActivity).toContain("User is a data scientist.");
  });
});

describe("getLastThreePasses", () => {
  it("returns empty string when log file does not exist", async () => {
    const result = await getLastThreePasses(join(tmpDir, "nonexistent.md"));
    expect(result).toBe("");
  });

  it("returns last 3 pass sections from log", async () => {
    const logPath = join(tmpDir, "log.md");
    const content = [
      "## 2026-05-20T08:00:00Z — Pass pass-1\n\n**Summary:** One.\n\n---\n",
      "## 2026-05-20T08:15:00Z — Pass pass-2\n\n**Summary:** Two.\n\n---\n",
      "## 2026-05-20T08:30:00Z — Pass pass-3\n\n**Summary:** Three.\n\n---\n",
      "## 2026-05-20T08:45:00Z — Pass pass-4\n\n**Summary:** Four.\n\n---\n",
    ].join("\n");
    await writeFile(logPath, content);

    const result = await getLastThreePasses(logPath);
    expect(result).not.toContain("pass-1");
    expect(result).toContain("pass-2");
    expect(result).toContain("pass-3");
    expect(result).toContain("pass-4");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { buildContextFromDirs, resolveContextDirs, getLastThreePasses } from "./context-builder.js";
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

// Real OpenClaw session transcript line: role/content nested under `message`,
// content as text-block arrays. The original parser expected {role, content}
// at top level and silently matched nothing on production.
function transcriptLine(role: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id: "m1",
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text }], timestamp: new Date().toISOString() },
  });
}

describe("buildContextFromDirs", () => {
  it("returns empty context when session dir does not exist", async () => {
    const bundle = await buildContextFromDirs(config, join(tmpDir, "sessions"), [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("No recent session activity");
  });

  it("extracts user/assistant messages from the real transcript schema", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.jsonl"), [
      JSON.stringify({ type: "session", id: "s", version: 1 }),
      transcriptLine("user", "What is the plan?"),
      JSON.stringify({ type: "model_change", id: "mc" }),
      transcriptLine("assistant", "Ship the doctor release."),
    ].join("\n") + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("What is the plan?");
    expect(bundle.recentActivity).toContain("Ship the doctor release.");
    expect(bundle.recentActivity).not.toContain("model_change");
  });

  it("still accepts legacy top-level {role, content} lines and string content", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.jsonl"),
      JSON.stringify({ role: "user", content: "legacy shape" }) + "\n" +
      JSON.stringify({ type: "message", message: { role: "user", content: "plain string content" } }) + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("legacy shape");
    expect(bundle.recentActivity).toContain("plain string content");
  });

  it("ignores trajectory sidecar files even though they end in .jsonl", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.trajectory.jsonl"),
      JSON.stringify({ type: "message", data: {}, message: { role: "user", content: "trajectory noise" } }) + "\n");
    await writeFile(join(sessionDir, "abc.jsonl"), transcriptLine("user", "real message") + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("real message");
    expect(bundle.recentActivity).not.toContain("trajectory noise");
  });

  it("skips malformed JSONL lines without crashing", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.jsonl"), "not-json\n" + transcriptLine("user", "hello") + "\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.recentActivity).toContain("hello");
  });

  it("trims content to stay within maxContextTokens", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.jsonl"), transcriptLine("user", "x".repeat(100000)) + "\n");

    const smallConfig = { ...config, context: { lookbackHours: 24, maxContextTokens: 100 } };
    const bundle = await buildContextFromDirs(smallConfig, sessionDir, [join(tmpDir, "memory")]);
    expect(bundle.tokenEstimate).toBeLessThanOrEqual(150);
  });

  it("reads memory from multiple dirs (wiki vault first), newest files first", async () => {
    const sessionDir = join(tmpDir, "sessions");
    const wikiDir = join(tmpDir, "wiki");
    const legacyDir = join(tmpDir, "memory");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(wikiDir, { recursive: true });
    await mkdir(legacyDir, { recursive: true });
    const { utimes } = await import("fs/promises");
    await writeFile(join(wikiDir, "old-note.md"), "Old wiki note.\n");
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await utimes(join(wikiDir, "old-note.md"), old, old);
    await writeFile(join(wikiDir, "fresh-note.md"), "Voice minutes spiked for one customer.\n");
    await writeFile(join(legacyDir, "fact.md"), "User is a data scientist.\n");

    const bundle = await buildContextFromDirs(config, sessionDir, [wikiDir, legacyDir]);
    expect(bundle.recentActivity).toContain("Voice minutes spiked");
    expect(bundle.recentActivity).toContain("data scientist");
    // Newest-first ordering: the fresh note appears before the 90-day-old one.
    expect(bundle.recentActivity.indexOf("Voice minutes spiked"))
      .toBeLessThan(bundle.recentActivity.indexOf("Old wiki note"));
  });

  it("tolerates missing memory dirs", async () => {
    const sessionDir = join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "abc.jsonl"), transcriptLine("user", "hi there friend") + "\n");
    const bundle = await buildContextFromDirs(config, sessionDir, [join(tmpDir, "nope"), join(tmpDir, "also-nope")]);
    expect(bundle.recentActivity).toContain("hi there friend");
  });
});

describe("resolveContextDirs", () => {
  it("uses runtime resolvers and the configured wiki vault", () => {
    const api = {
      config: { plugins: { entries: { "memory-wiki": { config: { vault: { path: "/data/wiki/main" } } } } } },
      runtime: {
        state: { resolveStateDir: () => "/state" },
        agent: { resolveAgentDir: () => "/state/agents/main" },
      },
    };
    const dirs = resolveContextDirs(api, "main");
    expect(dirs.sessionsDir).toBe("/state/agents/main/sessions");
    expect(dirs.memoryDirs[0]).toBe("/data/wiki/main");
    expect(dirs.memoryDirs).toContain("/state/agents/main/memory");
  });

  it("falls back to state-dir conventions when resolvers are absent", () => {
    const dirs = resolveContextDirs({ config: {}, runtime: { state: { resolveStateDir: () => "/state" } } }, "main");
    expect(dirs.sessionsDir).toBe("/state/agents/main/sessions");
    expect(dirs.memoryDirs).toContain("/state/wiki/main");
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

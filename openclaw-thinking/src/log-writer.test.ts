import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { appendPass, appendError, appendSkipped, appendStructuredProposals } from "./log-writer.js";
import type { ProposalSet } from "./types.js";

const proposals: ProposalSet = {
  pass_id: "test-pass-1",
  timestamp: "2026-05-20T08:15:00.000Z",
  observations: [{ id: "obs-1", text: "Something odd", evidence: "session A", priority: 3 }],
  proposed_actions: [{ id: "act-1", text: "Investigate", rationale: "because", estimated_effort: "small", priority: 4 }],
  proposed_audits: [{ id: "aud-1", domain: "auth", rationale: "no audit exists", priority: 2 }],
  open_questions: [{ id: "q-1", text: "Is X broken?", blocking_what: "nothing" }],
  nothing_to_report: false,
  summary: "Reviewed recent activity.",
};

let tmpDir: string;
let logPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "log-writer-test-"));
  logPath = join(tmpDir, "log.md");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

describe("appendPass", () => {
  it("creates the file if it does not exist", async () => {
    await appendPass(proposals, logPath);
    const content = await readFile(logPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("includes the pass_id in the output", async () => {
    await appendPass(proposals, logPath);
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("test-pass-1");
  });

  it("includes the summary", async () => {
    await appendPass(proposals, logPath);
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("Reviewed recent activity.");
  });

  it("includes proposal IDs for each type", async () => {
    await appendPass(proposals, logPath);
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("[obs-1]");
    expect(content).toContain("[act-1]");
    expect(content).toContain("[aud-1]");
    expect(content).toContain("[q-1]");
  });

  it("appends to existing content", async () => {
    await appendPass(proposals, logPath);
    await appendPass({ ...proposals, pass_id: "test-pass-2" }, logPath);
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("test-pass-1");
    expect(content).toContain("test-pass-2");
  });

  it("formats nothing_to_report correctly", async () => {
    const ntr = { ...proposals, nothing_to_report: true, observations: [], proposed_actions: [], proposed_audits: [], open_questions: [] };
    await appendPass(ntr, logPath);
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("nothing_to_report: true");
  });
});

describe("appendError", () => {
  it("writes a parse error entry", async () => {
    await appendError("err-pass-1", "missing field: pass_id", logPath);
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("err-pass-1");
    expect(content).toContain("parse error");
    expect(content).toContain("missing field: pass_id");
  });
});

describe("appendSkipped", () => {
  it("writes a skipped entry", async () => {
    await appendSkipped("outside_active_hours", logPath);
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("Skipped");
    expect(content).toContain("outside_active_hours");
  });
});

describe("appendStructuredProposals", () => {
  it("writes proposals as a JSONL line to .jsonl sidecar path", async () => {
    await appendStructuredProposals(proposals, logPath);
    const jsonlPath = join(tmpDir, "log.jsonl");
    const content = await readFile(jsonlPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.pass_id).toBe("test-pass-1");
  });

  it("appends multiple passes as separate lines", async () => {
    await appendStructuredProposals(proposals, logPath);
    await appendStructuredProposals({ ...proposals, pass_id: "test-pass-2" }, logPath);
    const jsonlPath = join(tmpDir, "log.jsonl");
    const lines = (await readFile(jsonlPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).pass_id).toBe("test-pass-2");
  });
});

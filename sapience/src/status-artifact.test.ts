import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { resolveStatusDir, writeStatusArtifact, readStatusArtifacts } from "./status-artifact.js";
import type { StatusArtifact } from "./doctor/types.js";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sapience-status-"));
  env = { OPENCLAW_STATE_DIR: dir };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const artifact = (id: string): StatusArtifact => ({
  pluginId: id,
  version: "0.2.3",
  agentId: "main",
  resolvedWorkspaceDir: "/ws",
  outputPaths: { eventsPath: "/ws/sapience/events.jsonl" },
  initAt: new Date(1_800_000_000_000).toISOString(),
});

describe("status-artifact", () => {
  it("resolves the status dir under the OPENCLAW_STATE_DIR override", () => {
    expect(resolveStatusDir(env)).toBe(join(dir, "sapience", "status"));
  });

  it("round-trips a written artifact keyed by pluginId", async () => {
    await writeStatusArtifact(artifact("sapience-thinking"), env);
    await writeStatusArtifact(artifact("sapience"), env);
    const read = await readStatusArtifacts(env);
    expect(Object.keys(read).sort()).toEqual(["sapience", "sapience-thinking"]);
    expect(read["sapience"]!.resolvedWorkspaceDir).toBe("/ws");
  });

  it("returns empty when the status dir does not exist", async () => {
    const read = await readStatusArtifacts({ OPENCLAW_STATE_DIR: join(dir, "nope") });
    expect(read).toEqual({});
  });
});

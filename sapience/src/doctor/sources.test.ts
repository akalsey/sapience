import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseCronListJson, toCronObservation, pluginToolsAllowedGlobally, goalToolCollision,
  scanInstalledVersions, readLegacyRootPins, findCorruptFiles,
} from "./sources.js";

describe("parseCronListJson", () => {
  it("extracts the jobs array from `openclaw cron list --json` output", () => {
    const stdout = JSON.stringify({
      jobs: [
        { name: "sapience-thinking", enabled: true, state: { lastRunStatus: "ok" } },
        { name: "sapience-routing", enabled: true, state: { lastRunStatus: "ok" } },
      ],
      nextOffset: 2,
    });
    const jobs = parseCronListJson(stdout);
    expect(jobs.map((j) => j.name)).toEqual(["sapience-thinking", "sapience-routing"]);
  });

  it("accepts a bare array", () => {
    const jobs = parseCronListJson(JSON.stringify([{ name: "x" }]));
    expect(jobs).toHaveLength(1);
  });

  it("returns [] on empty/garbage/missing jobs", () => {
    expect(parseCronListJson("")).toEqual([]);
    expect(parseCronListJson("not json")).toEqual([]);
    expect(parseCronListJson(JSON.stringify({ other: 1 }))).toEqual([]);
  });
});

describe("toCronObservation", () => {
  it("captures the job's payload.toolsAllow grant", () => {
    const obs = toCronObservation("sapience-routing", [
      { name: "sapience-routing", enabled: true, payload: { toolsAllow: ["process_proposals"] }, state: {} },
    ]);
    expect(obs.job?.toolsAllow).toEqual(["process_proposals"]);
  });

  it("leaves toolsAllow undefined when the payload has no grant", () => {
    const obs = toCronObservation("sapience-routing", [
      { name: "sapience-routing", enabled: true, payload: {}, state: {} },
    ]);
    expect(obs.job?.toolsAllow).toBeUndefined();
  });

  // A legacy "sapience-thinking-pass" job used to match the prefix and could
  // be picked over the real job, so the doctor reported the wrong job's state.
  it("prefers the exact-name job and records legacy duplicates", () => {
    const obs = toCronObservation("sapience-thinking", [
      { name: "sapience-thinking-pass", enabled: false, payload: {}, state: {} },
      { name: "sapience-thinking", enabled: true, payload: {}, state: {} },
    ]);
    expect(obs.job?.name).toBe("sapience-thinking");
    expect(obs.job?.enabled).toBe(true);
    expect(obs.extraMatches).toEqual(["sapience-thinking-pass"]);
  });
});

describe("filesystem version/corruption scans", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "doctor-scan-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("finds installed plugin versions under npm/projects", async () => {
    const pkgDir = join(dir, "npm", "projects", "akalsey-sapience-abc123", "node_modules", "@akalsey", "sapience");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@akalsey/sapience", version: "0.2.7" }));
    const versions = await scanInstalledVersions(dir, ["sapience", "sapience-goals"]);
    expect(versions).toEqual({ sapience: "0.2.7" });
  });

  it("reads legacy pins from the top-level npm package.json", async () => {
    await mkdir(join(dir, "npm"), { recursive: true });
    await writeFile(join(dir, "npm", "package.json"), JSON.stringify({
      dependencies: { "@akalsey/sapience": "0.1.3", "@openclaw/slack": "1.0.0" },
    }));
    expect(await readLegacyRootPins(dir, ["sapience", "sapience-goals"])).toEqual({ sapience: "0.1.3" });
  });

  it("finds quarantined corrupt state files in the workspace", async () => {
    await mkdir(join(dir, "goals"), { recursive: true });
    await mkdir(join(dir, "sapience"), { recursive: true });
    await writeFile(join(dir, "goals", "goals.json.corrupt-2026-07-01T00-00-00Z"), "{broken");
    await writeFile(join(dir, "goals", "goals.json"), "[]");
    const found = await findCorruptFiles(dir);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("goals.json.corrupt-");
  });

  it("scans tolerate missing directories", async () => {
    expect(await scanInstalledVersions(join(dir, "nope"), ["sapience"])).toEqual({});
    expect(await readLegacyRootPins(join(dir, "nope"), ["sapience"])).toEqual({});
    expect(await findCorruptFiles(join(dir, "nope"))).toEqual([]);
  });
});

describe("pluginToolsAllowedGlobally", () => {
  it("is true when no tools profile is set (nothing is filtered)", () => {
    expect(pluginToolsAllowedGlobally({})).toBe(true);
    expect(pluginToolsAllowedGlobally({ tools: {} })).toBe(true);
  });

  it("is true for the unrestricted 'full' profile", () => {
    expect(pluginToolsAllowedGlobally({ tools: { profile: "full" } })).toBe(true);
  });

  it("is false for a restrictive profile with no plugin allowance", () => {
    expect(pluginToolsAllowedGlobally({ tools: { profile: "coding" } })).toBe(false);
  });

  it("is true when alsoAllow or allow grants group:plugins past the profile", () => {
    expect(pluginToolsAllowedGlobally({ tools: { profile: "coding", alsoAllow: ["group:plugins"] } })).toBe(true);
    expect(pluginToolsAllowedGlobally({ tools: { profile: "coding", allow: ["group:plugins"] } })).toBe(true);
  });
});

describe("goalToolCollision", () => {
  const withGoals = (tools: any) => ({
    tools,
    plugins: { entries: { "sapience-goals": {} } },
  });

  it("reports all three core goal tools reachable under the coding profile", () => {
    expect(goalToolCollision(withGoals({ profile: "coding" })).reachable)
      .toEqual(["create_goal", "get_goal", "update_goal"]);
  });

  it("reports them reachable when no profile filters anything", () => {
    expect(goalToolCollision(withGoals({})).reachable).toHaveLength(3);
    expect(goalToolCollision(withGoals({ profile: "full" })).reachable).toHaveLength(3);
  });

  it("reports no collision for profiles whose scope excludes goals", () => {
    expect(goalToolCollision(withGoals({ profile: "messaging" })).reachable).toEqual([]);
    expect(goalToolCollision(withGoals({ profile: "minimal" })).reachable).toEqual([]);
  });

  it("treats deny as winning over the profile", () => {
    expect(goalToolCollision(withGoals({ profile: "coding", deny: ["create_goal", "get_goal", "update_goal"] })).reachable)
      .toEqual([]);
  });

  it("reports a partial deny as still colliding", () => {
    // Denying only create_goal leaves the other two to be picked instead.
    expect(goalToolCollision(withGoals({ profile: "coding", deny: ["create_goal"] })).reachable)
      .toEqual(["get_goal", "update_goal"]);
  });

  it("catches goal tools granted back by name past an excluding profile", () => {
    expect(goalToolCollision(withGoals({ profile: "messaging", alsoAllow: ["create_goal"] })).reachable)
      .toEqual(["create_goal"]);
  });

  it("preserves unrelated deny entries in the observation", () => {
    expect(goalToolCollision(withGoals({ profile: "coding", deny: ["browser"] })).deny).toEqual(["browser"]);
  });

  it("reports whether the goals plugin is installed at all", () => {
    expect(goalToolCollision({ tools: { profile: "coding" } }).goalsPluginInstalled).toBe(false);
    expect(goalToolCollision(withGoals({ profile: "coding" })).goalsPluginInstalled).toBe(true);
  });
});

describe("parseCronListJson noise tolerance", () => {
  // Defense in depth: CLI startup noise (migration warnings, banners) around
  // the JSON payload must not turn a healthy listing into "no jobs".
  it("extracts the JSON object from surrounding noise", () => {
    const noisy = '18:53:59 [state-migrations] Legacy state migration warnings:\n- left in place\n{"jobs":[{"name":"sapience-thinking","enabled":true}]}\nbye';
    const jobs = parseCronListJson(noisy);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("sapience-thinking");
  });

  it("extracts a bare array from surrounding noise", () => {
    const jobs = parseCronListJson('banner\n[{"name":"a"}]');
    expect(jobs).toHaveLength(1);
  });

  it("still returns [] for pure garbage", () => {
    expect(parseCronListJson("no json here at all")).toEqual([]);
  });
});

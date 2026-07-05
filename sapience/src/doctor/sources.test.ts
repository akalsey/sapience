import { describe, it, expect } from "vitest";
import { parseCronListJson, toCronObservation, pluginToolsAllowedGlobally } from "./sources.js";

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

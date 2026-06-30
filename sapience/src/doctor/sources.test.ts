import { describe, it, expect } from "vitest";
import { parseCronListJson } from "./sources.js";

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

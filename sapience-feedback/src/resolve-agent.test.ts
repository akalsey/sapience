import { describe, it, expect } from "vitest";
import { resolveAgentId, resolveRegistrableAgentId, FALLBACK_AGENT_ID } from "./resolve-agent.js";

describe("resolveAgentId", () => {
  it("reads the keyed agents.entries object a real install ships", () => {
    // Verified against a production openclaw.json: entries is an object whose
    // keys are the agent ids, and the sole entry carries neither id nor default.
    expect(resolveAgentId({ agents: { entries: { main: { workspace: "/w" } } } })).toBe("main");
    expect(resolveAgentId({ agents: { entries: { poppy: {} } } })).toBe("poppy");
  });

  it("prefers the entry flagged default over the first key", () => {
    const config = { agents: { entries: { alpha: {}, beta: { default: true } } } };
    expect(resolveAgentId(config)).toBe("beta");
  });

  it("lets an entry's own id override its object key", () => {
    const config = { agents: { entries: { stale: { id: "renamed" } } } };
    expect(resolveAgentId(config)).toBe("renamed");
  });

  it("accepts the array roster shape too", () => {
    expect(resolveAgentId({ agents: { list: [{ id: "one" }, { id: "two", default: true }] } })).toBe("two");
    expect(resolveAgentId({ agents: { entries: [{ id: "solo" }] } })).toBe("solo");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(resolveAgentId({ agents: { entries: { "  Main  ": {} } } })).toBe("main");
  });

  it("never returns the literal \"default\" for a roster-less config", () => {
    // The old `config.agent.id ?? "default"` read produced exactly that, and
    // any cron registered with it fails every run on this install.
    for (const config of [undefined, null, {}, { agents: {} }, { agents: { entries: {} } }, { agent: { id: "x" } }]) {
      expect(resolveAgentId(config)).toBe(FALLBACK_AGENT_ID);
      expect(resolveAgentId(config)).not.toBe("default");
    }
  });
});

describe("resolveRegistrableAgentId", () => {
  it("returns a real roster entry so cron registration can name it", () => {
    expect(resolveRegistrableAgentId({ agents: { entries: { poppy: {} } } })).toBe("poppy");
  });

  it("returns undefined rather than a guess when there is no roster", () => {
    // Omitting --agent lets openclaw's scheduler resolve the configured
    // default. Passing a guessed name is what produced permanently failing
    // jobs with "cron job agent is unavailable: default".
    for (const config of [undefined, null, {}, { agents: {} }, { agents: { entries: {} } }]) {
      expect(resolveRegistrableAgentId(config)).toBeUndefined();
    }
  });
});

import { describe, it, expect } from "vitest";
import { resolveMainSessionKey, enqueueMainSessionInjection } from "./main-session.js";

describe("resolveMainSessionKey", () => {
  it("defaults to agent:main:main with no config", () => {
    expect(resolveMainSessionKey(undefined)).toBe("agent:main:main");
    expect(resolveMainSessionKey({})).toBe("agent:main:main");
  });

  it("returns 'global' when session scope is global", () => {
    expect(resolveMainSessionKey({ session: { scope: "global" } })).toBe("global");
  });

  it("uses the default agent from agents.list, falling back to the first", () => {
    expect(resolveMainSessionKey({ agents: { list: [{ id: "ops" }, { id: "research", default: true }] } }))
      .toBe("agent:research:main");
    expect(resolveMainSessionKey({ agents: { list: [{ id: "ops" }, { id: "research" }] } }))
      .toBe("agent:ops:main");
  });

  it("honors a configured session.mainKey and normalizes case", () => {
    expect(resolveMainSessionKey({ session: { mainKey: "Primary" }, agents: { list: [{ id: "Main" }] } }))
      .toBe("agent:main:primary");
  });
});

describe("enqueueMainSessionInjection", () => {
  const config = {};

  it("passes sessionKey and text — the shape the gateway requires", async () => {
    let received: any;
    const api = {
      config,
      session: { workflow: { enqueueNextTurnInjection: async (inj: any) => { received = inj; return { enqueued: true, id: "1", sessionKey: inj.sessionKey }; } } },
    };
    const result = await enqueueMainSessionInjection(api, "hello");
    expect(result.enqueued).toBe(true);
    expect(received).toEqual({ sessionKey: "agent:main:main", text: "hello" });
  });

  it("reports failure when the gateway declines the injection", async () => {
    const api = {
      config,
      session: { workflow: { enqueueNextTurnInjection: async (inj: any) => ({ enqueued: false, id: "", sessionKey: inj.sessionKey }) } },
    };
    const result = await enqueueMainSessionInjection(api, "hello");
    expect(result.enqueued).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("reports failure when the injection API is missing entirely", async () => {
    const result = await enqueueMainSessionInjection({ config }, "hello");
    expect(result.enqueued).toBe(false);
    expect(result.reason).toContain("unavailable");
  });

  it("does not probe when the first enqueue succeeds", async () => {
    let calls = 0;
    const api = {
      config,
      session: { workflow: { enqueueNextTurnInjection: async (inj: any) => { calls++; return { enqueued: true, id: "1", sessionKey: inj.sessionKey }; } } },
    };
    await enqueueMainSessionInjection(api, "hello");
    expect(calls).toBe(1);
  });

  it("diagnoses an unwired noop handler: the probe's untrimmed key comes back verbatim", async () => {
    // openclaw's noop stub echoes injection.sessionKey untouched; the real
    // implementation trims it. A trailing-space probe tells them apart.
    const api = {
      config,
      session: { workflow: { enqueueNextTurnInjection: async (inj: any) => ({ enqueued: false, id: "", sessionKey: inj.sessionKey }) } },
    };
    const result = await enqueueMainSessionInjection(api, "hello");
    expect(result.enqueued).toBe(false);
    expect(result.reason).toContain("not wired");
  });

  it("diagnoses a store miss: the real gateway trims the probe key but still declines", async () => {
    const api = {
      config,
      session: { workflow: { enqueueNextTurnInjection: async (inj: any) => ({ enqueued: false, id: "", sessionKey: String(inj.sessionKey).trim() }) } },
    };
    const result = await enqueueMainSessionInjection(api, "hello");
    expect(result.enqueued).toBe(false);
    expect(result.reason).toContain("no session entry");
    expect(result.reason).toContain("agent:main:main");
  });

  it("reports failure instead of throwing when the enqueue call throws", async () => {
    const api = {
      config,
      session: { workflow: { enqueueNextTurnInjection: async () => { throw new Error("boom"); } } },
    };
    const result = await enqueueMainSessionInjection(api, "hello");
    expect(result.enqueued).toBe(false);
    expect(result.reason).toContain("boom");
  });
});

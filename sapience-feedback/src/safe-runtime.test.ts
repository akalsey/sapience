import { describe, it, expect } from "vitest";
import { readRuntime } from "./safe-runtime.js";

// A stand-in for the host during "cli-metadata" registration, where reading
// api.runtime throws rather than returning undefined.
function apiWithThrowingRuntime(message = 'runtime is intentionally unavailable during "cli-metadata" registration') {
  return {
    get runtime(): unknown {
      throw new Error(message);
    },
  };
}

describe("readRuntime", () => {
  it("never throws when reading the runtime itself throws", () => {
    const api = apiWithThrowingRuntime();
    expect(() => readRuntime(api, (r) => r.agent)).not.toThrow();
    const result = readRuntime(api, (r) => r.agent);
    expect(result.available).toBe(false);
    expect(String(result.error)).toContain("cli-metadata");
  });

  it("reports unavailable for an absent runtime without calling the reader", () => {
    let called = false;
    const result = readRuntime({}, (r) => { called = true; return r.agent; });
    expect(result).toEqual({ available: false });
    expect(called).toBe(false);
  });

  it("returns the read value when the runtime is real", () => {
    const api = { runtime: { agent: { resolveAgentWorkspaceDir: () => "/ws" } } };
    const result = readRuntime(api, (r) => r.agent.resolveAgentWorkspaceDir());
    expect(result).toEqual({ value: "/ws", available: true });
  });

  it("distinguishes a genuine read failure from the CLI-collection bail", () => {
    // A real gateway runtime whose resolver throws is a defect worth recording.
    // An absent runtime is not. The old code could not tell them apart without
    // a second read of the property that throws.
    const api = { runtime: { agent: { resolveAgentWorkspaceDir: () => { throw new Error("boom"); } } } };
    const result = readRuntime(api, (r) => r.agent.resolveAgentWorkspaceDir());
    expect(result.available).toBe(true);
    expect(String(result.error)).toContain("boom");
    expect(result.value).toBeUndefined();
  });

  it("survives a runtime getter that throws a non-Error", () => {
    const api = { get runtime(): unknown { throw "string throw"; } };
    expect(readRuntime(api, (r) => r.agent).available).toBe(false);
  });
});

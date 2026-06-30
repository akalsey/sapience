import { describe, it, expect } from "vitest";
import service from "./service.js";

// Regression: openclaw collects plugin CLI registrars by calling register() with
// an EMPTY runtime (api.runtime === {}). The workspace-resolution guard throws in
// that context and bails. The `sapience doctor` CLI registration must happen
// BEFORE that guard, or `openclaw sapience doctor` is never registered
// ("no such service: sapience").
describe("sapience plugin register() — CLI registration", () => {
  it("registers the CLI even when runtime.agent is absent (CLI-collection context)", () => {
    let cliCalls = 0;
    const api = {
      runtime: {}, // no .agent — resolveAgentWorkspaceDir will throw
      pluginConfig: {},
      config: {},
      registerCli: () => { cliCalls++; },
      registerTool: () => { throw new Error("registerTool should not be reached in this context"); },
    };

    expect(() => service.register(api)).not.toThrow();
    expect(cliCalls).toBe(1);
  });
});

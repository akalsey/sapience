import { describe, it, expect } from "vitest";
import { registerSapienceDoctorCli, cronRegisterArgs } from "./cli.js";
import { SUITE_CRONS } from "./inventory.js";

// Minimal chainable Commander stub. Records the command tree so we can assert
// structure without a real CLI.
function makeCommand(name: string): any {
  const children: any[] = [];
  const self: any = {
    name,
    children,
    command(n: string) { const c = makeCommand(n); children.push(c); return c; },
    description() { return self; },
    option() { return self; },
    action() { return self; },
  };
  return self;
}

// Capture the registrar passed to api.registerCli, then run it against a stub
// top-level program (which already has a built-in "doctor", like real openclaw).
function runRegistrar() {
  let registrar: ((ctx: any) => void) | undefined;
  const api = {
    config: {},
    registerCli: (fn: (ctx: any) => void) => { registrar = fn; },
  };
  registerSapienceDoctorCli(api);
  const program = makeCommand("openclaw");
  program.command("doctor"); // openclaw's own top-level doctor command
  registrar!({ program, config: {} });
  return program;
}

describe("registerSapienceDoctorCli command tree", () => {
  it("nests 'doctor' under a 'sapience' group, not at the top level", () => {
    const program = runRegistrar();

    const sapience = program.children.find((c: any) => c.name === "sapience");
    expect(sapience).toBeDefined();
    expect(sapience.children.some((c: any) => c.name === "doctor")).toBe(true);
  });

  it("does not add a second top-level 'doctor' (avoids colliding with openclaw's)", () => {
    const program = runRegistrar();
    const topLevelDoctors = program.children.filter((c: any) => c.name === "doctor");
    expect(topLevelDoctors.length).toBe(1); // only openclaw's built-in one
  });
});

describe("cronRegisterArgs", () => {
  it("grants the plugin tools to the isolated session via --tools", () => {
    const args = cronRegisterArgs("sapience-thinking", "main");
    const i = args.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("get_thinking_context,record_thinking_output");
  });

  it("registers every suite cron with its own tool grant", () => {
    for (const c of SUITE_CRONS) {
      const args = cronRegisterArgs(c.base, "main");
      expect(args[args.indexOf("--tools") + 1]).toBe(c.tools.join(","));
    }
  });

  it("throws on an unknown cron base", () => {
    expect(() => cronRegisterArgs("nonsense", "main")).toThrow();
  });
});

describe("SUITE_CRONS messages", () => {
  it("tell the agent to bail silently when its tool is unavailable, instead of improvising", () => {
    for (const c of SUITE_CRONS) {
      expect(c.message).toContain("If the tool is not available, reply SILENT_REPLY_TOKEN and stop.");
    }
  });
});

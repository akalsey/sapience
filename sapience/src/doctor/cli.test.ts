import { describe, it, expect } from "vitest";
import { registerSapienceDoctorCli } from "./cli.js";

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

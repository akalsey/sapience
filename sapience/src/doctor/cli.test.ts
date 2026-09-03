import { describe, it, expect } from "vitest";
import { registerSapienceDoctorCli, deliveryTargetFromEnv } from "./cli.js";
import { SUITE_CRONS, DELIVERY_POLL_CRON } from "./inventory.js";

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

  it("exposes deliver-check, the command the poll cron runs", () => {
    // The sapience-poll-delivery cron's payload is literally
    // `openclaw sapience deliver-check`; if this subcommand is not registered
    // the poll job errors every fifteen minutes.
    const program = runRegistrar();
    const sapience = program.children.find((c: any) => c.name === "sapience");
    expect(sapience.children.some((c: any) => c.name === "deliver-check")).toBe(true);
  });

  it("registers exactly the command string the poll cron is given", () => {
    // The seam: cron-args.test.ts asserts the payload string and the test above
    // asserts the subcommand exists, but nothing checked they name the same
    // thing. A rename on either side would leave a job that errors every run.
    const group = runRegistrar().children.find((c: any) => c.name === "sapience");
    const [groupName, sub] = DELIVERY_POLL_CRON.subcommand;

    expect(DELIVERY_POLL_CRON.subcommand).toHaveLength(2);
    expect(groupName).toBe(group.name);
    expect(group.children.map((c: any) => c.name)).toContain(sub);
  });
});

// Registration-argument shapes are covered in cron-args.test.ts.

describe("deliveryTargetFromEnv", () => {
  it("reads the same env contract install.sh uses", () => {
    expect(deliveryTargetFromEnv({ SAPIENCE_DELIVERY_CHANNEL: "slack", SAPIENCE_DELIVERY_TO: "channel:C1" }))
      .toEqual({ channel: "slack", to: "channel:C1" });
  });

  it("defaults the channel but never invents a target", () => {
    expect(deliveryTargetFromEnv({ SAPIENCE_DELIVERY_TO: "-100123" }))
      .toEqual({ channel: "telegram", to: "-100123" });
    expect(deliveryTargetFromEnv({ SAPIENCE_DELIVERY_CHANNEL: "telegram" })).toBeUndefined();
    expect(deliveryTargetFromEnv({})).toBeUndefined();
  });
});

describe("SUITE_CRONS messages", () => {
  it("tell the agent to bail silently when its tool is unavailable, instead of improvising", () => {
    for (const c of SUITE_CRONS) {
      expect(c.message).toContain("If the tool is not available, reply NO_REPLY and stop.");
    }
  });
});

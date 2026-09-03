import { describe, it, expect } from "vitest";
import { cronRegisterArgs, deliveryPollRegisterArgs } from "./cron-args.js";
import { SUITE_CRONS, DELIVERY_CRON_BASE, DELIVERY_POLL_CRON_BASE } from "./inventory.js";

const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const AGENT_CRONS = SUITE_CRONS.map((c) => c.base);

describe("cronRegisterArgs", () => {
  it("grants the plugin tools to the isolated session via --tools", () => {
    expect(value(cronRegisterArgs("sapience-thinking"), "--tools"))
      .toBe("get_thinking_context,record_thinking_output");
  });

  it("registers every suite cron with its own tool grant", () => {
    for (const c of SUITE_CRONS) {
      expect(value(cronRegisterArgs(c.base), "--tools")).toBe(c.tools.join(","));
    }
  });

  it("throws on an unknown cron base", () => {
    expect(() => cronRegisterArgs("nonsense")).toThrow();
  });

  it("gives every job a sapience-namespaced declaration key so re-runs converge", () => {
    // Without one, each installer run mints a new job instead of updating the
    // existing one — a production install accumulated two copies each of three
    // jobs, created eight days apart.
    const keys = new Set<string>();
    for (const base of AGENT_CRONS) {
      const key = value(cronRegisterArgs(base), "--declaration-key")!;
      expect(key.startsWith("sapience:")).toBe(true);
      keys.add(key);
    }
    keys.add(value(deliveryPollRegisterArgs({ openclawBin: "/bin/openclaw" }), "--declaration-key")!);
    expect(keys.size).toBe(AGENT_CRONS.length + 1);
  });

  it("keeps clear of the gateway's reserved declaration namespaces", () => {
    const reserved = ["heartbeat:", "heartbeat-task:", "skill-collection-review:"];
    for (const base of AGENT_CRONS) {
      const key = value(cronRegisterArgs(base), "--declaration-key")!;
      for (const prefix of reserved) expect(key.startsWith(prefix)).toBe(false);
    }
  });

  it("scopes the declaration key per agent so multi-agent copies stay distinct", () => {
    // Two jobs sharing a key inside one caller scope make the upsert ambiguous
    // and openclaw rejects the second outright.
    const a = value(cronRegisterArgs("sapience-routing", { agentId: "alpha", name: "sapience-routing-alpha" }), "--declaration-key");
    const b = value(cronRegisterArgs("sapience-routing", { agentId: "beta", name: "sapience-routing-beta" }), "--declaration-key");
    expect(a).not.toBe(b);
    expect(a).toBe("sapience:routing:alpha");
  });

  it("gives the doctor and the installer the SAME key on a single-agent install", () => {
    // install.sh suffixes neither name nor key when there is one agent. The
    // doctor registers base names but used to suffix the key whenever it could
    // resolve an agent id, producing "sapience:delivery:main" against the
    // installer's "sapience:delivery" — so an installer run could not match the
    // doctor's job and minted a duplicate beside it. The qualifier now derives
    // from the name, so the two agree by construction.
    const doctorStyle = value(cronRegisterArgs("sapience-delivery", { agentId: "main" }), "--declaration-key");
    const installerStyle = value(cronRegisterArgs("sapience-delivery", {}), "--declaration-key");
    expect(doctorStyle).toBe("sapience:delivery");
    expect(doctorStyle).toBe(installerStyle);
  });

  it("omits --agent when no agent id is known", () => {
    const args = cronRegisterArgs("sapience-routing");
    expect(args).not.toContain("--agent");
    expect(args).not.toContain("default");
  });

  it("skips workspace bootstrap injection on every agent job", () => {
    for (const base of AGENT_CRONS) {
      expect(cronRegisterArgs(base)).toContain("--light-context");
    }
  });

  it("ships the delivery job disabled, since the poll job starts it on demand", () => {
    expect(cronRegisterArgs(DELIVERY_CRON_BASE)).toContain("--disabled");
    for (const base of AGENT_CRONS.filter((b) => b !== DELIVERY_CRON_BASE)) {
      expect(cronRegisterArgs(base)).not.toContain("--disabled");
    }
  });

  it("keeps announce on the delivery cron and off the others when no target is pinned", () => {
    const delivery = cronRegisterArgs(DELIVERY_CRON_BASE);
    expect(delivery).toContain("--announce");
    expect(delivery).not.toContain("--no-deliver");
    for (const base of AGENT_CRONS.filter((b) => b !== DELIVERY_CRON_BASE)) {
      const args = cronRegisterArgs(base);
      expect(args).toContain("--no-deliver");
      expect(args).not.toContain("--announce");
    }
  });

  it("drops the announce route entirely when a delivery target is pinned", () => {
    // With no announce route the runner never fallback-delivers, so an empty
    // turn or a malformed tool call is silent rather than shipping the host's
    // "no final summary was produced" placeholder to the operator's chat.
    const args = cronRegisterArgs(DELIVERY_CRON_BASE, {
      deliveryTarget: { channel: "telegram", to: "-100123" },
    });
    expect(args).not.toContain("--announce");
    expect(args).toContain("--no-deliver");
    expect(value(args, "--channel")).toBe("telegram");
    expect(value(args, "--to")).toBe("-100123");
  });

  it("grants the message tool and names the target when delivery is pinned", () => {
    const args = cronRegisterArgs(DELIVERY_CRON_BASE, {
      deliveryTarget: { channel: "telegram", to: "-100123" },
    });
    expect(value(args, "--tools")!.split(",")).toContain("message");
    const message = value(args, "--message")!;
    expect(message).toContain("telegram");
    expect(message).toContain("-100123");
    expect(message).toContain("NO_REPLY");
  });

  it("never sets a model on any job", () => {
    // The suite has no basis for an opinion about a user's model preferences,
    // so it does not express one — not on registration, and not by carrying
    // across a value found on an existing job. A replacement that drops an
    // operator's pin reports it instead, leaving the choice with them.
    for (const base of AGENT_CRONS) {
      expect(cronRegisterArgs(base)).not.toContain("--model");
    }
    expect(deliveryPollRegisterArgs({ openclawBin: "/bin/openclaw" })).not.toContain("--model");
  });

  it("never emits the constant's name in place of the silent token", () => {
    for (const base of AGENT_CRONS) {
      const message = value(cronRegisterArgs(base), "--message")!;
      expect(message).toContain("NO_REPLY");
      expect(message).not.toContain("SILENT_REPLY_TOKEN");
    }
  });
});

describe("deliveryPollRegisterArgs", () => {
  it("registers a command payload, so no model turn runs on an empty queue", () => {
    const args = deliveryPollRegisterArgs({ openclawBin: "/usr/local/bin/openclaw" });
    expect(value(args, "--name")).toBe(DELIVERY_POLL_CRON_BASE);
    expect(value(args, "--cron")).toBe("*/15 * * * *");
  });

  it("uses argv with an absolute binary path, not a shell string", () => {
    // The gateway runs a command payload through `sh -lc`. On Debian/Ubuntu sh
    // is dash, which does not read the profile that puts an npm-global bin dir
    // on PATH, so a bare "openclaw" exits 127 — ten times in production, until
    // the job auto-disabled itself.
    const args = deliveryPollRegisterArgs({ openclawBin: "/usr/local/bin/openclaw" });
    expect(args).not.toContain("--command");
    expect(JSON.parse(value(args, "--command-argv")!))
      .toEqual(["/usr/local/bin/openclaw", "sapience", "deliver-check"]);
  });

  it("carries no delivery route of its own", () => {
    const args = deliveryPollRegisterArgs({ openclawBin: "/bin/openclaw" });
    expect(args).toContain("--no-deliver");
    expect(args).not.toContain("--announce");
  });

  it("passes no agent-turn-only flags a command payload would ignore", () => {
    const args = deliveryPollRegisterArgs({ openclawBin: "/bin/openclaw" });
    for (const flag of ["--tools", "--message", "--light-context", "--model"]) {
      expect(args).not.toContain(flag);
    }
  });

  it("cannot be confused with a multi-agent copy of the delivery job", () => {
    // The doctor matches jobs by "<base>-" prefix. A name like
    // "sapience-delivery-poll" would be indistinguishable from
    // "sapience-delivery-<agent>".
    expect(DELIVERY_POLL_CRON_BASE.startsWith(`${DELIVERY_CRON_BASE}-`)).toBe(false);
  });
});

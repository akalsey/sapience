import { describe, it, expect } from "vitest";
import { auditCronName, auditDeclarationKey, buildAuditCronArgs, scheduleAudit } from "./audit-scheduler.js";

describe("auditCronName", () => {
  it("builds a stable sapience-audit slug from the audit text", () => {
    expect(auditCronName("salesforce: duplicate account detection has no coverage"))
      .toBe("sapience-audit-salesforce-duplicate-account-detection");
  });

  it("caps length and strips noise characters", () => {
    const name = auditCronName("x".repeat(200) + " !!! ???");
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name).toMatch(/^sapience-audit-[a-z0-9-]+$/);
  });
});

describe("auditDeclarationKey", () => {
  it("namespaces the job under sapience so re-registration converges", () => {
    expect(auditDeclarationKey("sapience-audit-x")).toBe("sapience:audit:sapience-audit-x");
  });

  it("stays clear of the gateway's reserved namespaces", () => {
    const key = auditDeclarationKey("sapience-audit-x");
    expect(key.startsWith("heartbeat:")).toBe(false);
    expect(key.startsWith("heartbeat-task:")).toBe(false);
    expect(key.startsWith("skill-collection-review:")).toBe(false);
  });
});

describe("buildAuditCronArgs", () => {
  const argValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("registers a weekly isolated job that reports findings", () => {
    const args = buildAuditCronArgs("sapience-audit-x", "salesforce: dupes", "main");
    expect(args.slice(0, 2)).toEqual(["cron", "add"]);
    expect(argValue(args, "--name")).toBe("sapience-audit-x");
    expect(argValue(args, "--cron")).toBe("0 9 * * 1");
    expect(argValue(args, "--agent")).toBe("main");
    const message = argValue(args, "--message")!;
    expect(message).toContain("salesforce: dupes");
    expect(message.toLowerCase()).toContain("audit");
  });

  it("asks for silence rather than a one-line summary on the clean-bill path", () => {
    // A one-line "nothing to report" is still a delivered message on any job
    // that later gains a delivery route, and it does not match the silent-token
    // shape every other job in the suite uses.
    const message = argValue(buildAuditCronArgs("sapience-audit-x", "dupes", "main"), "--message")!;
    expect(message).toContain("NO_REPLY");
    expect(message).not.toMatch(/keep it to one line/i);
  });

  it("carries a declaration key so re-registering converges instead of duplicating", () => {
    const args = buildAuditCronArgs("sapience-audit-x", "dupes", "main");
    expect(argValue(args, "--declaration-key")).toBe("sapience:audit:sapience-audit-x");
  });

  it("skips workspace bootstrap injection", () => {
    expect(buildAuditCronArgs("sapience-audit-x", "dupes", "main")).toContain("--light-context");
  });

  it("keeps the job off any delivery route", () => {
    expect(buildAuditCronArgs("sapience-audit-x", "dupes", "main")).toContain("--no-deliver");
  });

  it("omits --agent entirely when no agent id is known", () => {
    // Storing a guessed id is what produced jobs that fail every run with
    // "cron job agent is unavailable: default". With the flag absent the
    // scheduler resolves the configured default itself.
    const args = buildAuditCronArgs("sapience-audit-x", "dupes", undefined);
    expect(args).not.toContain("--agent");
    expect(args).not.toContain("default");
  });
});

describe("scheduleAudit", () => {
  it("invokes the cron registration and reports the name", async () => {
    const calls: string[][] = [];
    const exec = async (_cmd: string, args: string[]) => { calls.push(args); };
    const result = await scheduleAudit("salesforce: dupes", "main", exec);
    expect(result.ok).toBe(true);
    expect(result.name).toContain("sapience-audit-");
    expect(calls).toHaveLength(1);
  });

  it("reports failure without throwing", async () => {
    const exec = async () => { throw new Error("gateway down"); };
    const result = await scheduleAudit("salesforce: dupes", "main", exec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("gateway down");
  });
});

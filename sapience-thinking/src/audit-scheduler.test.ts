import { describe, it, expect } from "vitest";
import { auditCronName, buildAuditCronArgs, scheduleAudit } from "./audit-scheduler.js";

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

describe("buildAuditCronArgs", () => {
  it("registers a weekly isolated job that reports findings", () => {
    const args = buildAuditCronArgs("sapience-audit-x", "salesforce: dupes", "main");
    expect(args.slice(0, 2)).toEqual(["cron", "add"]);
    expect(args[args.indexOf("--name") + 1]).toBe("sapience-audit-x");
    expect(args[args.indexOf("--cron") + 1]).toBe("0 9 * * 1");
    expect(args[args.indexOf("--agent") + 1]).toBe("main");
    const message = args[args.indexOf("--message") + 1]!;
    expect(message).toContain("salesforce: dupes");
    expect(message.toLowerCase()).toContain("audit");
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

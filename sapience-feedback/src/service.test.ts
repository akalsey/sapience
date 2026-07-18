import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import service from "./service.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "feedback-service-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// Registration-surface test: the passive capture path previously guarded on
// api.session.onMessage — an API that doesn't exist — so the plugin's headline
// feature silently never registered. This pins capture to the real hook API.
function makeApi() {
  const hooks: Array<{ events: string | string[]; handler: (event: any) => Promise<void> | void; opts?: { name?: string } }> = [];
  const commands: any[] = [];
  return {
    hooks,
    commands,
    pluginConfig: { semanticDetection: { enabled: false } },
    config: {},
    runtime: { agent: { resolveAgentWorkspaceDir: () => dir } },
    // Mirrors the gateway's registry: a hook registration without opts.name
    // throws "hook registration missing name" and kills the whole register().
    registerHook: (events: string | string[], handler: any, opts?: { name?: string }) => {
      if (!opts?.name?.trim()) throw new Error("hook registration missing name");
      hooks.push({ events, handler, opts });
    },
    registerCommand: (cmd: any) => { commands.push(cmd); },
  };
}

describe("sapience-feedback registration", () => {
  it("registers a named message hook for passive capture", () => {
    const api = makeApi();
    service.register(api as any);
    const messageHook = api.hooks.find((h) => h.events === "message" || (Array.isArray(h.events) && h.events.includes("message")));
    expect(messageHook).toBeDefined();
    expect(messageHook!.opts?.name).toBeTruthy();
  });

  it("persists a regex-detectable correction from a received message", async () => {
    const api = makeApi();
    service.register(api as any);
    const hook = api.hooks[0]!;
    await hook.handler({
      type: "message",
      action: "received",
      sessionKey: "agent:main:main",
      context: { content: "don't push to github without asking me first", channelId: "telegram", from: "1" },
      timestamp: new Date(),
      messages: [],
    });
    const log = await readFile(join(dir, "sapience", "feedback.md"), "utf-8");
    expect(log.toLowerCase()).toContain("github");
  });

  it("ignores sent messages and non-string content", async () => {
    const api = makeApi();
    service.register(api as any);
    const hook = api.hooks[0]!;
    await hook.handler({ type: "message", action: "sent", sessionKey: "k", context: { content: "don't push to github without asking" }, timestamp: new Date(), messages: [] });
    await hook.handler({ type: "message", action: "received", sessionKey: "k", context: { content: [{ type: "image" }] }, timestamp: new Date(), messages: [] });
    await expect(readFile(join(dir, "sapience", "feedback.md"), "utf-8")).rejects.toThrow();
  });

  it("still registers the /feedback command", () => {
    const api = makeApi();
    service.register(api as any);
    expect(api.commands.some((c) => c.name === "feedback")).toBe(true);
  });
});

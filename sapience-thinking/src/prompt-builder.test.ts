import { describe, it, expect } from "vitest";
import { buildPrompt, buildHeartbeatPrompt } from "./prompt-builder.js";
import type { ContextBundle, SignalReport } from "./types.js";

const bundle: ContextBundle = {
  recentActivity: "Recent activity here.",
  recentPasses: "## 2026-05-20T08:00:00Z — Pass pass-1\n\n**Summary:** Old pass.\n\n---",
  tokenEstimate: 100,
};

const signal: SignalReport = {
  observations: { reviewed: 5, acted_on: 2, total: 10 },
  actions: { acted_on: 3, rejected: 2, total: 8 },
  audits: { accepted: 4, total: 5 },
  questions: { answered: 3, total: 4 },
  computed_at: "2026-05-20T08:00:00Z",
};

describe("buildPrompt", () => {
  it("includes recent activity in output", async () => {
    const prompt = await buildPrompt(bundle, null);
    expect(prompt).toContain("Recent activity here.");
  });

  it("includes recent passes in output", async () => {
    const prompt = await buildPrompt(bundle, null);
    expect(prompt).toContain("Old pass.");
  });

  it("omits signal section when signal is null", async () => {
    const prompt = await buildPrompt(bundle, null);
    expect(prompt).not.toContain("Signal-to-Noise");
  });

  it("includes signal section when signal is provided", async () => {
    const prompt = await buildPrompt(bundle, signal);
    expect(prompt).toContain("Signal-to-Noise");
    expect(prompt).toContain("20%"); // 2/10 acted_on for observations
  });

  it("omits recent passes section when recentPasses is empty", async () => {
    const noPassesBundle = { ...bundle, recentPasses: "" };
    const prompt = await buildPrompt(noPassesBundle, null);
    expect(prompt).not.toContain("Recent Proposals");
  });

  // The templates must be compiled-in constants, not files read relative to the
  // module: `tsc` doesn't copy .md assets into dist, so installed builds ENOENT'd
  // on every pass. This pins the template content to the module itself.
  it("builds the template without touching the filesystem", async () => {
    const { readFile } = await import("fs/promises");
    const originalSrc = await readFile(new URL("./prompt-builder.ts", import.meta.url), "utf-8");
    expect(originalSrc).not.toContain("readFile");
    const prompt = await buildPrompt(bundle, null);
    expect(prompt).toContain("scheduled thinking pass");
    expect(prompt).toContain("record_thinking_output()");
  });
});

describe("goal-aware prompt", () => {
  it("includes an Active Goals section when the bundle carries goals", async () => {
    const prompt = await buildPrompt({ ...bundle, activeGoals: "- Reduce churn [active]\n  approach: outreach" }, null);
    expect(prompt).toContain("## Active Goals");
    expect(prompt).toContain("Reduce churn");
  });

  it("omits the goals section when there are none", async () => {
    const prompt = await buildPrompt(bundle, null);
    expect(prompt).not.toContain("## Active Goals");
  });
});

describe("buildHeartbeatPrompt", () => {
  it("substitutes the proposals list into the compiled-in template", async () => {
    const prompt = await buildHeartbeatPrompt("- fix the flux capacitor");
    expect(prompt).toContain("- fix the flux capacitor");
    expect(prompt).not.toContain("[PROPOSALS LIST]");
    expect(prompt).toContain("SILENT_REPLY_TOKEN");
  });
});

describe("playbooks section", () => {
  it("renders analytical playbooks when provided", async () => {
    const prompt = buildPrompt(bundle, null, [
      { id: "x", title: "X", instruction: "When an aggregate metric moved, decompose before reporting." },
    ]);
    expect(prompt).toContain("## Analytical Playbooks");
    expect(prompt).toContain("decompose before reporting");
  });

  it("omits the section without playbooks", async () => {
    expect(buildPrompt(bundle, null)).not.toContain("## Analytical Playbooks");
  });
});

import { describe, it, expect } from "vitest";
import { buildPrompt } from "./prompt-builder.js";
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
});

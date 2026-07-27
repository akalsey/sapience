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

  // A resolved problem was resurfacing a day later: the pass flagged a
  // point-in-time issue ("unable to access Google Sheets") from one turn or one
  // memory note without reading the later evidence that showed it fixed. Pin
  // the whole-timeline instruction so the pass reconciles against resolution.
  it("instructs the pass to read the whole timeline and skip resolved problems", async () => {
    const prompt = await buildPrompt(bundle, null);
    expect(prompt).toContain("whole body of evidence");
    expect(prompt).toContain("resolved");
  });
});

describe("delivery-aware prompt", () => {
  it("surfaces the delivery warning ahead of the pass history so silence is not misread", async () => {
    const warned: ContextBundle = {
      ...bundle,
      deliveryWarning: "Delivery has been FAILING: 6 recent proposals never reached the user.",
    };
    const prompt = await buildPrompt(warned, null);
    expect(prompt).toContain("never reached the user");
    expect(prompt.indexOf("never reached the user")).toBeLessThan(prompt.indexOf("Old pass."));
  });

  it("omits the section when there is no warning", async () => {
    const prompt = await buildPrompt(bundle, null);
    expect(prompt).not.toContain("Delivery Status");
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
  });

  it("instructs silence with openclaw's recognized NO_REPLY token, not the legacy invented one", async () => {
    // openclaw only treats the literal "NO_REPLY" as a valid silent completion
    // (auto-reply/tokens.ts). Prompting an unrecognized token left runs ending
    // in empty responses, which cron flagged as "Agent couldn't generate a
    // response" on every quiet pass.
    const prompt = await buildHeartbeatPrompt("- item");
    expect(prompt).toContain("NO_REPLY");
    expect(prompt).not.toContain("SILENT_REPLY_TOKEN");
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

  it("frames playbooks as techniques, never as pending tasks to execute", async () => {
    // A one-time directive that leaked into the playbook file was read as an
    // outstanding user mandate and re-proposed every pass. The section must
    // tell the pass that playbooks are analytical moves, not a todo list.
    const prompt = buildPrompt(bundle, null, [
      { id: "x", title: "X", instruction: "Do the following now: delete the temp files." },
    ]);
    expect(prompt).toMatch(/techniques, not tasks/i);
    expect(prompt).toMatch(/never propose executing a playbook/i);
  });
});

describe("open skill proposals section", () => {
  it("surfaces open proposals with a no-re-propose instruction", async () => {
    const prompt = buildPrompt({ ...bundle, openSkillProposals: "- [s1] weekly-usage-divergence — WoW attribution (proposed, evidence ×2)" }, null);
    expect(prompt).toContain("## Open Skill Proposals");
    expect(prompt).toContain("weekly-usage-divergence");
    expect(prompt).toMatch(/don'?t re-propose/i);
  });

  it("omits the section when there are none", async () => {
    expect(buildPrompt(bundle, null)).not.toContain("## Open Skill Proposals");
  });
});

describe("repetition watch", () => {
  it("the base prompt tells passes to watch for repeated multi-step tasks", async () => {
    expect(buildPrompt(bundle, null)).toContain("same multi-step task");
  });
});

describe("open hypotheses section", () => {
  it("surfaces open hypotheses for opportunistic re-testing", async () => {
    const prompt = buildPrompt({ ...bundle, openHypotheses: "- [open] spend velocity decays before churn (seen 3x)" }, null);
    expect(prompt).toContain("## Open Hypotheses");
    expect(prompt).toContain("spend velocity decays");
  });
});

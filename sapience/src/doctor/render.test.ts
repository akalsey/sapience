import { describe, it, expect } from "vitest";
import { renderReport, renderJson } from "./render.js";
import type { DoctorReport } from "./types.js";

const report: DoctorReport = {
  sections: [
    { title: "PLUGINS", findings: [{ id: "plugin:sapience", severity: "ok", message: "sapience v0.2.3 initialized" }] },
    { title: "MEMORY", findings: [{ id: "memory:bridgeEnabled", severity: "warn", message: "memory-wiki bridge is unset, expected true",
        fix: { autofixable: true, kind: "config-set", description: "set plugins.memory-wiki.bridge.enabled = true", payload: { path: "x", value: true } } }] },
  ],
  summary: { ok: 1, warn: 1, error: 0 },
  exitCode: 0,
};

describe("renderReport", () => {
  it("renders sections, marks, details and fix hints", () => {
    const out = renderReport(report);
    expect(out).toContain("PLUGINS");
    expect(out).toContain("✓ sapience v0.2.3 initialized");
    expect(out).toContain("⚠ memory-wiki bridge is unset");
    expect(out).toContain("fix: set plugins.memory-wiki.bridge.enabled = true");
    expect(out).toContain("Summary: 1 ok · 1 warn · 0 error");
  });

  it("adds a healthy line only when no warn/error", () => {
    const clean: DoctorReport = { sections: [], summary: { ok: 3, warn: 0, error: 0 }, exitCode: 0 };
    expect(renderReport(clean)).toContain("Everything looks healthy.");
    expect(renderReport(report)).not.toContain("Everything looks healthy.");
  });
});

describe("renderJson", () => {
  it("round-trips to the same report", () => {
    expect(JSON.parse(renderJson(report))).toEqual(report);
  });
});

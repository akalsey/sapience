import type { DoctorReport, Severity } from "./types.js";

const MARK: Record<Severity, string> = { ok: "✓", warn: "⚠", error: "✗" };

export function renderReport(r: DoctorReport): string {
  const lines: string[] = ["Sapience Suite — doctor", ""];
  for (const s of r.sections) {
    lines.push(s.title);
    for (const f of s.findings) {
      lines.push(`  ${MARK[f.severity]} ${f.message}`);
      if (f.detail) lines.push(`      ${f.detail}`);
      if (f.fix) lines.push(`      fix: ${f.fix.description}`);
    }
    lines.push("");
  }
  lines.push(`Summary: ${r.summary.ok} ok · ${r.summary.warn} warn · ${r.summary.error} error`);
  if (r.summary.error === 0 && r.summary.warn === 0) lines.push("Everything looks healthy.");
  return lines.join("\n");
}

export function renderJson(r: DoctorReport): string {
  return JSON.stringify(r, null, 2);
}

import type { DoctorReport, Finding, FixDescriptor } from "./types.js";

export interface FixAction {
  finding: Finding;
  kind: "config-set" | "cron-register";
  payload: Record<string, unknown>;
}

// Only findings explicitly marked autofixable with a payload are actionable.
export function planFixes(r: DoctorReport): FixAction[] {
  type Actionable = Finding & { fix: FixDescriptor & { payload: Record<string, unknown> } };
  return r.sections
    .flatMap((s) => s.findings)
    .filter((f): f is Actionable => Boolean(f.fix?.autofixable && f.fix.payload))
    .map((f) => ({ finding: f, kind: f.fix.kind, payload: f.fix.payload }));
}

// Side effects are injected so this stays unit-testable and the CLI owns the real
// config writer / cron registrar.
export interface FixEffectors {
  setConfig(path: string, value: unknown): Promise<void>;
  registerCron(base: string): Promise<void>;
}

export async function applyFixes(actions: FixAction[], eff: FixEffectors): Promise<string[]> {
  const done: string[] = [];
  for (const a of actions) {
    if (a.kind === "config-set") {
      await eff.setConfig(a.payload.path as string, a.payload.value);
      done.push(`set ${a.payload.path} = ${String(a.payload.value)}`);
    } else if (a.kind === "cron-register") {
      await eff.registerCron(a.payload.base as string);
      done.push(`registered cron ${a.payload.base}`);
    }
  }
  return done;
}

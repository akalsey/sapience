import type { DoctorReport, Finding, FixDescriptor } from "./types.js";

export interface FixAction {
  finding?: Finding;
  kind: FixDescriptor["kind"];
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
  updatePlugin(pluginId: string): Promise<void>;
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
    } else if (a.kind === "delivery-target-set") {
      // The three delivering plugins share the delivery.sessionKey convention
      // (sapience-feedback never injects).
      const sessionKey = a.payload.sessionKey as string;
      for (const id of ["sapience", "sapience-thinking", "sapience-goals"]) {
        await eff.setConfig(`plugins.entries.${id}.config.delivery.sessionKey`, sessionKey);
      }
      done.push(`routed suite deliveries to ${sessionKey}`);
    } else if (a.kind === "plugin-update") {
      await eff.updatePlugin(a.payload.pluginId as string);
      done.push(`updated ${a.payload.pluginId} (restart the gateway to load it)`);
    }
  }
  return done;
}

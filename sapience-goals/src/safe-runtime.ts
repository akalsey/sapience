// Reading api.runtime without letting it kill register().
//
// OpenClaw calls register() in contexts where the runtime deliberately does not
// exist — most importantly "cli-metadata" collection, where it walks plugins
// only to learn which root CLI commands they add. In that mode `api.runtime` is
// not merely absent: reading it THROWS.
//
//   Plugin "sapience" runtime is intentionally unavailable during "cli-metadata"
//   registration. Declare root commands in the manifest's cliCommands or defer
//   runtime access out of register().
//
// The suite already wrapped its one register-time runtime read in a try/catch,
// but the catch block then asked `if (api?.runtime?.agent)` to decide whether
// the failure was real or the expected CLI-collection bail. Optional chaining on
// `api` does nothing about a getter on `.runtime` that throws, so the second
// read threw again from inside the catch, escaped register(), and the gateway
// reported the whole plugin as failed — taking `openclaw sapience doctor` with
// it, which is the command an operator would reach for to diagnose exactly this.
//
// Read the runtime once, through here, and never touch it again on the failure
// path. The manifest's `cliCommands` is the other half of the fix: it lets the
// host learn the command surface without executing plugin code at all.

export interface SafeRuntimeRead<T> {
  value?: T;
  // True when the runtime was reachable and shaped as expected. False both when
  // reading it threw and when it was simply absent — the caller cannot tell
  // those apart and must not try, because telling them apart is what required
  // the second read.
  available: boolean;
  error?: unknown;
}

export function readRuntime<T>(api: any, read: (runtime: any) => T): SafeRuntimeRead<T> {
  let runtime: any;
  try {
    runtime = api?.runtime;
  } catch (error) {
    return { available: false, error };
  }
  if (!runtime) return { available: false };
  try {
    return { value: read(runtime), available: true };
  } catch (error) {
    // The runtime existed but the read failed — a genuine problem worth
    // recording, distinct from the CLI-collection bail above.
    return { available: true, error };
  }
}

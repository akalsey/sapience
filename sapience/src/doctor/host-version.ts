// What OpenClaw version the suite is running against, and what that implies.
//
// The suite supports 2026.7.1 and newer. Everything it needs — `--declaration-key`,
// `--light-context`, and command-payload jobs — exists in both the 2026.07 and
// 2026.08 lines, so there is no feature gating here. What DID change at 2026.8.1
// is how a scheduled job stays quiet, and that changes what counts as a healthy
// job configuration:
//
//   - The heartbeat-acknowledgement filter is gone. `isHeartbeatOnlyResponse()`
//     and `resolveHeartbeatAckMaxChars()` existed at 2026.7.1 and suppressed a
//     reply of HEARTBEAT_OK plus up to 300 further characters. Neither exists
//     now; the delivery path recognizes only NO_REPLY.
//   - Producing no text at all stopped being silent. The runner retries an
//     empty post-tool turn and then substitutes a placeholder sentence, which
//     is final text — so an `announce` job delivers it.
//
// Together those mean a job with an announce route has exactly one quiet path
// on 2026.8+: a reply that is the bare token and nothing else. Depending on a
// model to find that path on every run, forever, is not a design — hence the
// poll job, and hence this check.

export const MIN_SUPPORTED_HOST_VERSION = "2026.7.1";
// The release that removed heartbeat-ack suppression and added the empty-turn
// placeholder substitution.
export const STRICT_SILENCE_HOST_VERSION = "2026.8.1";

export interface HostVersionObservation {
  // As reported by `openclaw --version`, or undefined when it could not be read.
  version?: string;
  raw?: string;
  error?: string;
}

// openclaw versions are `YYYY.M.P` with an optional prerelease suffix
// ("2026.8.1-beta.3"). Parse leniently: the version can appear alone or inside
// a longer banner line.
export function parseHostVersion(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /\b(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(raw);
  return match?.[1];
}

interface ParsedVersion {
  numbers: number[];
  prerelease?: string;
}

function parse(version: string): ParsedVersion | undefined {
  const [core, prerelease] = version.split("-", 2);
  const numbers = (core ?? "").split(".").map((n) => Number.parseInt(n, 10));
  if (numbers.length !== 3 || numbers.some((n) => !Number.isFinite(n))) return undefined;
  return prerelease ? { numbers, prerelease } : { numbers };
}

// True when `version` is at least `floor`. A prerelease sorts before its own
// release ("2026.8.1-beta.3" < "2026.8.1"), matching semver.
export function isAtLeast(version: string | undefined, floor: string): boolean {
  const a = version ? parse(version) : undefined;
  const b = parse(floor);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    const diff = a.numbers[i]! - b.numbers[i]!;
    if (diff !== 0) return diff > 0;
  }
  if (a.prerelease && !b.prerelease) return false;
  if (!a.prerelease && b.prerelease) return true;
  if (a.prerelease && b.prerelease) return a.prerelease >= b.prerelease;
  return true;
}

export function isSupportedHost(version: string | undefined): boolean {
  return isAtLeast(version, MIN_SUPPORTED_HOST_VERSION);
}

// Whether this host treats anything other than a bare NO_REPLY as deliverable
// output from a scheduled job.
export function hasStrictSilenceContract(version: string | undefined): boolean {
  return isAtLeast(version, STRICT_SILENCE_HOST_VERSION);
}

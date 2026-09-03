import { describe, it, expect } from "vitest";
import {
  parseHostVersion,
  isAtLeast,
  isSupportedHost,
  hasStrictSilenceContract,
  MIN_SUPPORTED_HOST_VERSION,
  STRICT_SILENCE_HOST_VERSION,
} from "./host-version.js";

describe("parseHostVersion", () => {
  it("reads a bare version", () => {
    expect(parseHostVersion("2026.8.1")).toBe("2026.8.1");
  });

  it("finds the version inside a banner line", () => {
    expect(parseHostVersion("openclaw 2026.7.1 (darwin-arm64)\n")).toBe("2026.7.1");
  });

  it("keeps a prerelease suffix", () => {
    expect(parseHostVersion("2026.8.1-beta.3")).toBe("2026.8.1-beta.3");
  });

  it("returns undefined for output with no version in it", () => {
    expect(parseHostVersion("command not found")).toBeUndefined();
    expect(parseHostVersion("")).toBeUndefined();
    expect(parseHostVersion(undefined)).toBeUndefined();
  });
});

describe("isAtLeast", () => {
  it("orders by each numeric field, not lexically", () => {
    // "2026.10.1" < "2026.9.1" lexically, but 10 > 9.
    expect(isAtLeast("2026.10.1", "2026.9.1")).toBe(true);
    expect(isAtLeast("2026.8.1", "2026.7.1")).toBe(true);
    expect(isAtLeast("2026.7.1", "2026.8.1")).toBe(false);
    expect(isAtLeast("2026.7.1", "2026.7.1")).toBe(true);
  });

  it("sorts a prerelease before its own release", () => {
    expect(isAtLeast("2026.8.1-beta.3", "2026.8.1")).toBe(false);
    expect(isAtLeast("2026.8.1", "2026.8.1-beta.3")).toBe(true);
    expect(isAtLeast("2026.8.1-beta.3", "2026.7.1")).toBe(true);
  });

  it("is false for an unreadable version rather than optimistic", () => {
    expect(isAtLeast(undefined, "2026.7.1")).toBe(false);
    expect(isAtLeast("not-a-version", "2026.7.1")).toBe(false);
  });
});

describe("host contracts", () => {
  it("accepts the floor the suite is tested against", () => {
    expect(isSupportedHost(MIN_SUPPORTED_HOST_VERSION)).toBe(true);
    expect(isSupportedHost("2026.6.11")).toBe(false);
  });

  it("flags 2026.8.1 and later as the strict-silence line", () => {
    // 2026.8.1 dropped heartbeat-ack suppression and began substituting a
    // placeholder sentence for an empty post-tool turn.
    expect(hasStrictSilenceContract(STRICT_SILENCE_HOST_VERSION)).toBe(true);
    expect(hasStrictSilenceContract("2026.8.2")).toBe(true);
    expect(hasStrictSilenceContract("2026.9.1")).toBe(true);
    expect(hasStrictSilenceContract("2026.7.1")).toBe(false);
    expect(hasStrictSilenceContract("2026.7.2-beta.7")).toBe(false);
  });
});

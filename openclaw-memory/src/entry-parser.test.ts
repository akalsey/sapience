import { describe, it, expect } from "vitest";
import { parseEntry, serializeEntry } from "./entry-parser.js";

const RAW = `---
id: mem_2026-05-20_a3f9
created: "2026-05-20T14:30:00Z"
updated: "2026-05-20T14:30:00Z"
tags: [posthog, billing]
source: session
score: 0.7
size_tier: full
last_accessed: "2026-05-20T14:30:00Z"
access_count: 2
---

# PostHog Billing Investigation

The billing spike traced to groupIdentify on every page view.
`;

describe("parseEntry", () => {
  it("parses id and tags from frontmatter", () => {
    const entry = parseEntry(RAW, "2026-05-20-posthog-billing-a3f9.md");
    expect(entry.id).toBe("mem_2026-05-20_a3f9");
    expect(entry.tags).toEqual(["posthog", "billing"]);
  });

  it("extracts title from first H1", () => {
    const entry = parseEntry(RAW, "2026-05-20-posthog-billing-a3f9.md");
    expect(entry.title).toBe("PostHog Billing Investigation");
  });

  it("uses slug as title when no H1", () => {
    const raw = RAW.replace("# PostHog Billing Investigation\n\n", "");
    const entry = parseEntry(raw, "2026-05-20-posthog-billing-a3f9.md");
    expect(entry.title).toBe("posthog-billing-a3f9");
  });

  it("preserves access_count", () => {
    const entry = parseEntry(RAW, "2026-05-20-posthog-billing-a3f9.md");
    expect(entry.access_count).toBe(2);
  });

  it("stores filename", () => {
    const entry = parseEntry(RAW, "2026-05-20-posthog-billing-a3f9.md");
    expect(entry.filename).toBe("2026-05-20-posthog-billing-a3f9.md");
  });
});

describe("serializeEntry round-trip", () => {
  it("serialize → parse preserves all fields", () => {
    const original = parseEntry(RAW, "2026-05-20-posthog-billing-a3f9.md");
    const serialized = serializeEntry(original);
    const reparsed = parseEntry(serialized, original.filename);
    expect(reparsed.id).toBe(original.id);
    expect(reparsed.tags).toEqual(original.tags);
    expect(reparsed.title).toBe(original.title);
    expect(reparsed.access_count).toBe(original.access_count);
  });
});

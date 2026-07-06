import { describe, it, expect } from "vitest";
import { extractDomain, compileExtraDomains } from "./domains.js";

describe("extractDomain", () => {
  it("covers the union of both plugins' historical taxonomies", () => {
    // These lists had drifted apart (feedback lacked google-docs, etc.),
    // which produced feedback landing on domains routing never emitted.
    expect(extractDomain("open a GitHub PR")).toBe("github");
    expect(extractDomain("Salesforce contact query")).toBe("salesforce");
    expect(extractDomain("PostHog funnel analysis")).toBe("posthog");
    expect(extractDomain("update the deck slides")).toBe("slides");
    expect(extractDomain("share the google doc")).toBe("google-docs");
    expect(extractDomain("check the OKR progress")).toBe("okr-system");
    expect(extractDomain("post in slack")).toBe("slack");
    expect(extractDomain("linear ticket backlog")).toBe("linear");
    expect(extractDomain("password manager credentials")).toBe("credentials");
    expect(extractDomain("something vague")).toBe("general");
  });

  it("lets user-configured domains extend and take precedence", () => {
    const extra = compileExtraDomains({ "metabase": "metabase", "zoho": "support" });
    expect(extractDomain("the metabase dashboard is broken", extra)).toBe("metabase");
    expect(extractDomain("zoho ticket volume is up", extra)).toBe("support");
    // Extras win over builtins when both match.
    const override = compileExtraDomains({ "github enterprise": "ghe" });
    expect(extractDomain("github enterprise seats", override)).toBe("ghe");
  });

  it("skips invalid patterns without crashing", () => {
    const extra = compileExtraDomains({ "([bad": "broken", "fine": "fine" });
    expect(extra).toHaveLength(1);
    expect(extractDomain("that's fine", extra)).toBe("fine");
  });
});

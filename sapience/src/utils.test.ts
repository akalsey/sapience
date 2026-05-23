import { describe, it, expect } from "vitest";
import { resolvePath } from "./utils.js";
import { homedir } from "os";
import { join } from "path";

describe("resolvePath", () => {
  it("expands tilde", () => {
    expect(resolvePath("~/.openclaw/foo")).toBe(join(homedir(), ".openclaw/foo"));
  });
  it("leaves absolute paths unchanged", () => {
    expect(resolvePath("/tmp/foo")).toBe("/tmp/foo");
  });
});

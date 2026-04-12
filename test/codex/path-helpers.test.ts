import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../../src/codex/path-helpers.js";

describe("resolveRequiredHomeDir", () => {
  it("returns the current home directory", () => {
    expect(resolveRequiredHomeDir()).toBe(path.resolve(os.homedir()));
  });
});

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createLocalToolValidationSuiteResult } from "../../src/tools/local-tool-validation-suite.js";

describe("local tool validation suite", () => {
  it("validates document, command, and MCP tool flows through approvals", async () => {
    const result = await createLocalToolValidationSuiteResult();

    expect(result.status).toBe("passed");
    expect(result.scenarios).toEqual([
      expect.objectContaining({ name: "local document read, append, and replace", status: "passed" }),
      expect.objectContaining({ name: "allowlisted local command execution", status: "passed" }),
      expect.objectContaining({ name: "configured MCP stdio tool call", status: "passed" }),
    ]);
    expect(fs.existsSync(result.tempRoot)).toBe(false);
  });
});

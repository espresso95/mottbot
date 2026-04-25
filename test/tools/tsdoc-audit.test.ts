import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditTsdocSourceFile,
  createTsdocAuditResult,
  formatTsdocAuditReport,
  type TsdocAuditResult,
} from "../../src/tools/tsdoc-audit.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

describe("TSDoc audit", () => {
  it("detects documented and undocumented top-level exports", () => {
    const symbols = auditTsdocSourceFile(
      "src/example.ts",
      `
/** Does useful work. */
export function documented() {}

export function missing() {}

/** Public shape. */
export type PublicShape = { id: string };

const privateValue = 1;
export { privateValue };
`,
    );

    expect(symbols).toEqual([
      expect.objectContaining({ name: "documented", kind: "function", documented: true }),
      expect.objectContaining({ name: "missing", kind: "function", documented: false }),
      expect.objectContaining({ name: "PublicShape", kind: "type", documented: true }),
    ]);
  });

  it("summarizes a source tree using relative paths", () => {
    const tempDir = createTempDir();
    try {
      const sourceRoot = path.join(tempDir, "src");
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(
        path.join(sourceRoot, "sample.ts"),
        `/** Documented constant. */
export const documented = true;
export class MissingDocs {}
`,
        "utf8",
      );

      const result = createTsdocAuditResult("src", tempDir);

      expect(result).toMatchObject({
        sourceRoot: "src",
        fileCount: 1,
        totalExports: 2,
        documentedExports: 1,
        undocumentedExports: 1,
        coveragePercent: 50,
      });
      expect(result.undocumented[0]).toMatchObject({
        filePath: "src/sample.ts",
        line: 3,
        kind: "class",
        name: "MissingDocs",
      });
    } finally {
      removeTempDir(tempDir);
    }
  });

  it("formats a bounded text report", () => {
    const result: TsdocAuditResult = {
      sourceRoot: "src",
      fileCount: 1,
      totalExports: 3,
      documentedExports: 1,
      undocumentedExports: 2,
      coveragePercent: 33.33,
      undocumented: [
        { filePath: "src/a.ts", line: 1, column: 1, kind: "function", name: "first", documented: false },
        { filePath: "src/b.ts", line: 2, column: 1, kind: "class", name: "second", documented: false },
      ],
    };

    expect(formatTsdocAuditReport(result, 1)).toContain("src/a.ts:1:1 function first");
    expect(formatTsdocAuditReport(result, 1)).toContain("... 1 more.");
  });
});

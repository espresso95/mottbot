import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditTsdocSourceFile,
  createTsdocAuditResult,
  formatTsdocAuditReport,
  parseTsdocAuditCliOptions,
  runTsdocAuditCli,
  type TsdocAuditResult,
} from "../../src/tools/tsdoc-audit.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

describe("TSDoc audit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects documented and undocumented top-level exports", () => {
    const symbols = auditTsdocSourceFile(
      "src/example.ts",
      `
/** Does useful work. */
export function documented() {}

export function missing() {}

/** Public shape. */
export type PublicShape = { id: string };

/** Public interface. */
export interface PublicInterface { id: string }

/** Public enum. */
export enum PublicEnum { One = "one" }

/** Public variable. */
export let publicVariable = 1;

/** Default export. */
export default class DefaultExport {}

const privateValue = 1;
export { privateValue };
`,
    );

    expect(symbols).toEqual([
      expect.objectContaining({ name: "documented", kind: "function", documented: true }),
      expect.objectContaining({ name: "missing", kind: "function", documented: false }),
      expect.objectContaining({ name: "PublicShape", kind: "type", documented: true }),
      expect.objectContaining({ name: "PublicInterface", kind: "interface", documented: true }),
      expect.objectContaining({ name: "PublicEnum", kind: "enum", documented: true }),
      expect.objectContaining({ name: "publicVariable", kind: "variable", documented: true }),
      expect.objectContaining({ name: "DefaultExport", kind: "class", documented: true }),
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
    expect(formatTsdocAuditReport(result)).toContain("src/b.ts:2:1 class second");
    expect(formatTsdocAuditReport(result)).not.toContain("... 1 more.");
  });

  it("accepts a pnpm-style option separator in CLI mode", () => {
    const tempDir = createTempDir();
    try {
      const sourceRoot = path.join(tempDir, "src");
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(
        path.join(sourceRoot, "sample.ts"),
        `/** Documented value. */
export const documented = true;
`,
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", path.resolve("src/tools/tsdoc-audit.ts"), "--", "--root", sourceRoot, "--limit", "1"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("All exported symbols have TSDoc.");
    } finally {
      removeTempDir(tempDir);
    }
  });

  it("formats an all-documented report", () => {
    const result: TsdocAuditResult = {
      sourceRoot: "src",
      fileCount: 1,
      totalExports: 1,
      documentedExports: 1,
      undocumentedExports: 0,
      coveragePercent: 100,
      undocumented: [],
    };

    expect(formatTsdocAuditReport(result)).toContain("All exported symbols have TSDoc.");
  });

  it("parses CLI options and rejects invalid flags", () => {
    expect(
      parseTsdocAuditCliOptions(["--all", "--json", "--strict", "--root", "lib", "--limit=3", "--max-missing", "2"]),
    ).toEqual({
      sourceRoot: "lib",
      json: true,
      limit: 3,
      maxMissing: 2,
    });
    expect(parseTsdocAuditCliOptions(["--root=src", "--limit", "0", "--max-missing=1"])).toEqual({
      sourceRoot: "src",
      json: false,
      limit: 0,
      maxMissing: 1,
    });
    expect(() => parseTsdocAuditCliOptions(["--root"])).toThrow(/source directory/);
    expect(() => parseTsdocAuditCliOptions(["--limit", "-1"])).toThrow(/non-negative integer/);
    expect(() => parseTsdocAuditCliOptions(["--unknown"])).toThrow(/Unknown option/);
  });

  it("runs the CLI with text, JSON, and max-missing exit codes", () => {
    const tempDir = createTempDir();
    const previousCwd = process.cwd();
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    });
    try {
      const sourceRoot = path.join(tempDir, "src");
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(
        path.join(sourceRoot, "sample.ts"),
        `/** Documented function. */
export function ok() {}
export const missing = true;
`,
        "utf8",
      );
      process.chdir(tempDir);

      expect(runTsdocAuditCli(["--root", "src", "--limit", "1"])).toBe(0);
      expect(writes.join("")).toContain("Undocumented exports");
      writes.length = 0;

      expect(runTsdocAuditCli(["--root=src", "--json", "--max-missing=0"])).toBe(1);
      expect(JSON.parse(writes.join(""))).toMatchObject({
        sourceRoot: "src",
        undocumentedExports: 1,
      });
    } finally {
      process.chdir(previousCwd);
      removeTempDir(tempDir);
    }
  });
});

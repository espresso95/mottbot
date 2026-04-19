import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepositoryScope } from "../../src/tools/repository-scope.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("RepositoryScope", () => {
  it("resolves allowed paths under approved roots", () => {
    const root = createTempDir();
    try {
      writeFile(path.join(root, "src/index.ts"), "export const value = 1;\n");
      writeFile(path.join(root, "..notes.txt"), "valid repo file\n");
      const scope = createRepositoryScope({
        roots: [root],
        deniedPaths: [],
        maxReadBytes: 40_000,
        maxSearchMatches: 100,
        maxSearchBytes: 80_000,
        commandTimeoutMs: 5_000,
      });

      expect(scope.resolvePath({ targetPath: "src/index.ts" })).toMatchObject({
        displayPath: "src/index.ts",
      });
      expect(scope.resolvePath({ targetPath: "..notes.txt" })).toMatchObject({
        displayPath: "..notes.txt",
      });
      expect(scope.listRoots()[0]).toMatchObject({
        realPath: fs.realpathSync(root),
      });
    } finally {
      removeTempDir(root);
    }
  });

  it("requires an explicit root when multiple approved roots are configured", () => {
    const firstRoot = createTempDir();
    const secondRoot = createTempDir();
    try {
      writeFile(path.join(firstRoot, "first.txt"), "first\n");
      writeFile(path.join(secondRoot, "second.txt"), "second\n");
      const scope = createRepositoryScope({
        roots: [firstRoot, secondRoot],
        deniedPaths: [],
        maxReadBytes: 40_000,
        maxSearchMatches: 100,
        maxSearchBytes: 80_000,
        commandTimeoutMs: 5_000,
      });

      expect(() => scope.resolvePath({ targetPath: "first.txt" })).toThrow(/Multiple repository roots/);
      expect(scope.resolvePath({ root: path.basename(firstRoot), targetPath: "first.txt" })).toMatchObject({
        displayPath: "first.txt",
      });
      expect(scope.resolvePath({ root: fs.realpathSync(secondRoot), targetPath: "second.txt" })).toMatchObject({
        displayPath: "second.txt",
      });
      expect(() => scope.resolveRoot("unknown")).toThrow(/not approved/);
    } finally {
      removeTempDir(firstRoot);
      removeTempDir(secondRoot);
    }
  });

  it("rejects invalid root configuration", () => {
    const root = createTempDir();
    try {
      writeFile(path.join(root, "file.txt"), "not a directory\n");

      expect(() =>
        createRepositoryScope({
          roots: [path.join(root, "file.txt")],
          deniedPaths: [],
          maxReadBytes: 40_000,
          maxSearchMatches: 100,
          maxSearchBytes: 80_000,
          commandTimeoutMs: 5_000,
        }),
      ).toThrow(/not a directory/);
      expect(() =>
        createRepositoryScope({
          roots: [],
          deniedPaths: [],
          maxReadBytes: 40_000,
          maxSearchMatches: 100,
          maxSearchBytes: 80_000,
          commandTimeoutMs: 5_000,
        }),
      ).toThrow(/At least one repository root/);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects traversal, denied paths, and symlinks outside approved roots", () => {
    const root = createTempDir();
    const outside = createTempDir();
    try {
      writeFile(path.join(root, ".env"), "TOKEN=secret\n");
      writeFile(path.join(root, "data/mottbot.sqlite"), "sqlite\n");
      writeFile(path.join(root, "private/notes.txt"), "private\n");
      writeFile(path.join(outside, "outside.txt"), "outside\n");
      fs.symlinkSync(path.join(outside, "outside.txt"), path.join(root, "outside-link"));
      const scope = createRepositoryScope({
        roots: [root],
        deniedPaths: ["private"],
        maxReadBytes: 40_000,
        maxSearchMatches: 100,
        maxSearchBytes: 80_000,
        commandTimeoutMs: 5_000,
      });

      expect(() => scope.resolvePath({ targetPath: "../outside.txt" })).toThrow(/outside the approved root/);
      expect(() => scope.resolvePath({ targetPath: "%2e%2e/outside.txt" })).toThrow(/outside the approved root/);
      expect(() => scope.resolvePath({ targetPath: ".env" })).toThrow(/denied/);
      expect(() => scope.resolvePath({ targetPath: "data/mottbot.sqlite" })).toThrow(/denied/);
      expect(() => scope.resolvePath({ targetPath: "private/notes.txt" })).toThrow(/denied/);
      expect(() => scope.resolvePath({ targetPath: "outside-link" })).toThrow(/outside the approved root/);
      expect(() => scope.resolvePath({ targetPath: "src\0/index.ts" })).toThrow(/null byte/);
    } finally {
      removeTempDir(root);
      removeTempDir(outside);
    }
  });

  it("builds ripgrep denial globs for file and directory specs", () => {
    const root = createTempDir();
    try {
      const scope = createRepositoryScope({
        roots: [root],
        deniedPaths: ["private", "secrets/*.txt"],
        maxReadBytes: 40_000,
        maxSearchMatches: 100,
        maxSearchBytes: 80_000,
        commandTimeoutMs: 5_000,
      });

      expect(scope.rgGlobs()).toEqual(
        expect.arrayContaining(["!**/.env", "!**/.env/**", "!**/private", "!**/private/**", "!secrets/*.txt"]),
      );
    } finally {
      removeTempDir(root);
    }
  });
});

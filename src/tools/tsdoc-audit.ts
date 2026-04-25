#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** Top-level production export kinds included in the TSDoc audit. */
export type TsdocAuditSymbolKind = "class" | "const" | "enum" | "function" | "interface" | "type" | "variable";

/** One exported symbol found while scanning a TypeScript source file. */
export type TsdocAuditSymbol = {
  filePath: string;
  line: number;
  column: number;
  kind: TsdocAuditSymbolKind;
  name: string;
  documented: boolean;
};

/** Aggregate TSDoc coverage for a source tree. */
export type TsdocAuditResult = {
  sourceRoot: string;
  fileCount: number;
  totalExports: number;
  documentedExports: number;
  undocumentedExports: number;
  coveragePercent: number;
  undocumented: TsdocAuditSymbol[];
};

/** Parsed command-line options for the TSDoc audit CLI. */
export type TsdocAuditCliOptions = {
  sourceRoot: string;
  json: boolean;
  limit: number | undefined;
  maxMissing: number | undefined;
};

function normalizeDisplayPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function hasTsdocComment(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
  const nodeStart = node.getStart(sourceFile);
  return ranges.some((range) => {
    if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia) {
      return false;
    }
    const comment = sourceFile.text.slice(range.pos, range.end);
    const gap = sourceFile.text.slice(range.end, nodeStart);
    return comment.startsWith("/**") && gap.trim().length === 0;
  });
}

function symbolPosition(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

function declarationName(node: ts.NamedDeclaration | ts.VariableDeclaration, sourceFile: ts.SourceFile): string {
  if (node.name) {
    return node.name.getText(sourceFile);
  }
  return "default";
}

function variableKind(statement: ts.VariableStatement): "const" | "variable" {
  return statement.declarationList.flags & ts.NodeFlags.Const ? "const" : "variable";
}

function exportedSymbolsFromStatement(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  filePath: string,
): TsdocAuditSymbol[] {
  if (!hasExportModifier(statement)) {
    return [];
  }

  const documented = hasTsdocComment(statement, sourceFile);
  const position = symbolPosition(sourceFile, statement);
  const base = {
    filePath,
    line: position.line,
    column: position.column,
    documented,
  };

  if (ts.isClassDeclaration(statement)) {
    return [{ ...base, kind: "class", name: declarationName(statement, sourceFile) }];
  }
  if (ts.isEnumDeclaration(statement)) {
    return [{ ...base, kind: "enum", name: declarationName(statement, sourceFile) }];
  }
  if (ts.isFunctionDeclaration(statement)) {
    return [{ ...base, kind: "function", name: declarationName(statement, sourceFile) }];
  }
  if (ts.isInterfaceDeclaration(statement)) {
    return [{ ...base, kind: "interface", name: declarationName(statement, sourceFile) }];
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    return [{ ...base, kind: "type", name: declarationName(statement, sourceFile) }];
  }
  if (ts.isVariableStatement(statement)) {
    const kind = variableKind(statement);
    return statement.declarationList.declarations.map((declaration) => ({
      ...base,
      kind,
      name: declarationName(declaration, sourceFile),
    }));
  }

  return [];
}

function collectSourceFiles(sourceRoot: string): string[] {
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(sourceRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

/** Scans one TypeScript source file and returns its top-level exported symbols. */
export function auditTsdocSourceFile(filePath: string, sourceText: string): TsdocAuditSymbol[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  return sourceFile.statements.flatMap((statement) => exportedSymbolsFromStatement(statement, sourceFile, filePath));
}

/** Scans a source tree and summarizes exported-symbol TSDoc coverage. */
export function createTsdocAuditResult(sourceRoot = "src", cwd = process.cwd()): TsdocAuditResult {
  const absoluteRoot = path.resolve(cwd, sourceRoot);
  const sourceFiles = collectSourceFiles(absoluteRoot);
  const symbols = sourceFiles.flatMap((filePath) =>
    auditTsdocSourceFile(normalizeDisplayPath(path.relative(cwd, filePath)), fs.readFileSync(filePath, "utf8")),
  );
  const undocumented = symbols.filter((symbol) => !symbol.documented);
  const documentedExports = symbols.length - undocumented.length;
  const coveragePercent = symbols.length > 0 ? Number(((documentedExports / symbols.length) * 100).toFixed(2)) : 100;

  return {
    sourceRoot: normalizeDisplayPath(path.relative(cwd, absoluteRoot) || "."),
    fileCount: sourceFiles.length,
    totalExports: symbols.length,
    documentedExports,
    undocumentedExports: undocumented.length,
    coveragePercent,
    undocumented,
  };
}

/** Renders a stable, grep-friendly TSDoc audit report for terminal output. */
export function formatTsdocAuditReport(result: TsdocAuditResult, limit = 50): string {
  const lines = [
    `TSDoc audit for ${result.sourceRoot}`,
    `Files scanned: ${result.fileCount}`,
    `Exported symbols: ${result.totalExports}`,
    `Documented exports: ${result.documentedExports}`,
    `Undocumented exports: ${result.undocumentedExports}`,
    `Coverage: ${result.coveragePercent}%`,
  ];

  if (result.undocumented.length === 0) {
    return [...lines, "All exported symbols have TSDoc."].join("\n");
  }

  const visible = result.undocumented.slice(0, limit);
  lines.push(
    "",
    `Undocumented exports${visible.length < result.undocumented.length ? ` (first ${visible.length})` : ""}:`,
  );
  for (const symbol of visible) {
    lines.push(`${symbol.filePath}:${symbol.line}:${symbol.column} ${symbol.kind} ${symbol.name}`);
  }
  const remaining = result.undocumented.length - visible.length;
  if (remaining > 0) {
    lines.push(
      `... ${remaining} more. Re-run with --all or --limit ${result.undocumented.length} to show every entry.`,
    );
  }
  return lines.join("\n");
}

function readNumericOption(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

/** Parses command-line flags accepted by the TSDoc audit CLI. */
export function parseTsdocAuditCliOptions(argv: string[]): TsdocAuditCliOptions {
  const options: TsdocAuditCliOptions = {
    sourceRoot: "src",
    json: false,
    limit: 50,
    maxMissing: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--all") {
      options.limit = undefined;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--strict") {
      options.maxMissing = 0;
      continue;
    }
    if (arg === "--root") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--root must be followed by a source directory.");
      }
      options.sourceRoot = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      options.sourceRoot = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--limit") {
      options.limit = readNumericOption("--limit", argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      options.limit = readNumericOption("--limit", arg.slice("--limit=".length));
      continue;
    }
    if (arg === "--max-missing") {
      options.maxMissing = readNumericOption("--max-missing", argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-missing=")) {
      options.maxMissing = readNumericOption("--max-missing", arg.slice("--max-missing=".length));
      continue;
    }
    throw new Error(`Unknown option ${arg}.`);
  }

  return options;
}

/** Runs the TSDoc audit CLI and returns the intended process exit code. */
export function runTsdocAuditCli(argv: string[]): number {
  const options = parseTsdocAuditCliOptions(argv);
  const result = createTsdocAuditResult(options.sourceRoot);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTsdocAuditReport(result, options.limit)}\n`);
  }
  return typeof options.maxMissing === "number" && result.undocumentedExports > options.maxMissing ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = runTsdocAuditCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "TSDoc audit failed."}\n`);
    process.exitCode = 1;
  }
}

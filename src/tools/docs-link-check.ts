import fs from "node:fs";
import path from "node:path";

type BrokenLink = {
  filePath: string;
  line: number;
  target: string;
};

const ignoredDirectories = new Set([".git", ".vitest", "coverage", "data", "dist", "node_modules"]);
const markdownLinkPattern = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;

function normalizeDisplayPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function collectMarkdownFiles(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function lineNumberForOffset(sourceText: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (sourceText[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

function localTargetFromRawLink(rawLink: string): string | undefined {
  const trimmed = rawLink.trim();
  const target = trimmed.startsWith("<") ? trimmed.slice(1, trimmed.indexOf(">")) : trimmed.split(/\s+/)[0];
  if (!target || target.startsWith("#")) {
    return undefined;
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) {
    return undefined;
  }
  const withoutAnchor = target.split("#")[0];
  if (!withoutAnchor) {
    return undefined;
  }
  return withoutAnchor;
}

function checkedPathForTarget(markdownFile: string, target: string): string {
  const targetWithoutQuery = target.split("?")[0] ?? target;
  const decodedTarget = decodeURIComponent(targetWithoutQuery);
  return path.resolve(path.dirname(markdownFile), decodedTarget);
}

function findBrokenLinks(markdownFile: string, sourceText: string): BrokenLink[] {
  const brokenLinks: BrokenLink[] = [];
  for (const match of sourceText.matchAll(markdownLinkPattern)) {
    const rawTarget = match[1];
    if (!rawTarget) {
      continue;
    }
    const target = localTargetFromRawLink(rawTarget);
    if (!target) {
      continue;
    }
    const checkedPath = checkedPathForTarget(markdownFile, target);
    if (!fs.existsSync(checkedPath)) {
      brokenLinks.push({
        filePath: markdownFile,
        line: lineNumberForOffset(sourceText, match.index),
        target,
      });
    }
  }
  return brokenLinks;
}

function main(): void {
  const cwd = process.cwd();
  const markdownFiles = collectMarkdownFiles(cwd);
  const brokenLinks = markdownFiles.flatMap((filePath) => findBrokenLinks(filePath, fs.readFileSync(filePath, "utf8")));

  if (brokenLinks.length === 0) {
    process.stdout.write(`No broken markdown links found in ${markdownFiles.length} files.\n`);
    return;
  }

  process.stderr.write("Broken markdown links found:\n");
  for (const link of brokenLinks) {
    const relativePath = normalizeDisplayPath(path.relative(cwd, link.filePath));
    process.stderr.write(`- ${relativePath}:${link.line} -> ${link.target}\n`);
  }
  process.exitCode = 1;
}

main();

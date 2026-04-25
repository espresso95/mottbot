import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_DENIED_PATHS = [
  ".env",
  ".env.*",
  "mottbot.config.json",
  "auth.json",
  ".local",
  ".codex",
  ".git",
  "node_modules",
  "data",
  "dist",
  "coverage",
  "*.sqlite*",
  "*.sqlite3*",
  "*.db*",
  "*.log",
  "*.session*",
] as const;

type WorktreeManagerConfig = {
  repoRoots: string[];
  worktreeRoot: string;
};

/** Worktree path and branch prepared for project-mode worker or integration work. */
type PreparedWorktree = {
  worktreePath: string;
  branchName: string;
};

/** Result from attempting to merge a branch into an integration worktree. */
type MergeResult = {
  ok: boolean;
  output: string;
};

/** Output from pushing a project-mode branch and optionally opening a pull request. */
type PublishBranchResult = {
  pushOutput: string;
  pullRequestUrl?: string;
  pullRequestOutput?: string;
};

function normalizeDisplayPath(value: string): string {
  return value.split(path.sep).join("/");
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function pathSegments(relativePath: string): string[] {
  return normalizeDisplayPath(relativePath).split("/").filter(Boolean);
}

function matchesDeniedPath(relativePath: string, spec: string): boolean {
  const normalizedRelative = normalizeDisplayPath(relativePath).replace(/^\.?\//, "");
  const normalizedSpec = normalizeDisplayPath(spec).replace(/^\.?\//, "");
  if (!normalizedRelative || !normalizedSpec) {
    return false;
  }
  const matchesSpec = wildcardToRegExp(normalizedSpec);
  if (!normalizedSpec.includes("/")) {
    return pathSegments(normalizedRelative).some((segment) => matchesSpec.test(segment));
  }
  return (
    matchesSpec.test(normalizedRelative) ||
    normalizedRelative.toLowerCase().startsWith(`${normalizedSpec.toLowerCase()}/`)
  );
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sanitizeBranchPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

function shellGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function shellCommand(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

function assertSafeBranchRef(value: string, label: string): void {
  const trimmed = value.trim();
  const isSafe =
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed) &&
    !trimmed.includes("..") &&
    !trimmed.includes("//") &&
    !trimmed.includes("@{") &&
    !trimmed.endsWith("/") &&
    !trimmed.endsWith(".") &&
    !trimmed.endsWith(".lock");
  if (!isSafe) {
    throw new Error(`${label} is not a safe branch ref.`);
  }
}

/** Creates, validates, merges, and cleans project-mode Git worktrees within approved roots. */
export class WorktreeManager {
  private readonly repoRoots: string[];
  private readonly deniedPaths: string[];
  private readonly worktreeRoot: string;

  constructor(config: WorktreeManagerConfig) {
    this.repoRoots = config.repoRoots.map((entry) => fs.realpathSync(path.resolve(entry)));
    this.worktreeRoot = path.resolve(config.worktreeRoot);
    fs.mkdirSync(this.worktreeRoot, { recursive: true });
    this.deniedPaths = [
      ...DEFAULT_DENIED_PATHS,
      ...(process.env.MOTTBOT_REPOSITORY_DENIED_PATHS ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ];
  }

  prepareSubtask(params: { taskId: string; subtaskId: string; repoRoot: string; baseRef: string }): PreparedWorktree {
    const repoRoot = this.resolveApprovedRepoRoot(params.repoRoot);
    const branchName = `mottbot/${sanitizeBranchPart(params.taskId)}/${sanitizeBranchPart(params.subtaskId)}`;
    const worktreePath = path.join(
      this.worktreeRoot,
      sanitizeBranchPart(params.taskId),
      sanitizeBranchPart(params.subtaskId),
    );
    this.cleanupSubtask({ repoRoot, worktreePath, branchName });
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    shellGit(repoRoot, ["worktree", "add", "--detach", worktreePath, params.baseRef]);
    shellGit(worktreePath, ["switch", "-c", branchName]);
    return { worktreePath, branchName };
  }

  prepareIntegration(params: { taskId: string; repoRoot: string; baseRef: string }): PreparedWorktree {
    const repoRoot = this.resolveApprovedRepoRoot(params.repoRoot);
    const branchName = `mottbot/${sanitizeBranchPart(params.taskId)}/integration`;
    const worktreePath = path.join(this.worktreeRoot, sanitizeBranchPart(params.taskId), "integration");
    this.cleanupSubtask({ repoRoot, worktreePath, branchName });
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    shellGit(repoRoot, ["worktree", "add", "--detach", worktreePath, params.baseRef]);
    shellGit(worktreePath, ["switch", "-c", branchName]);
    return { worktreePath, branchName };
  }

  mergeBranch(params: { worktreePath: string; branchName: string }): MergeResult {
    try {
      const output = shellGit(params.worktreePath, ["merge", "--no-ff", "--no-edit", params.branchName]);
      return { ok: true, output };
    } catch (error) {
      const maybe = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
      const output = [
        typeof maybe.stdout === "string"
          ? maybe.stdout
          : Buffer.isBuffer(maybe.stdout)
            ? maybe.stdout.toString("utf8")
            : undefined,
        typeof maybe.stderr === "string"
          ? maybe.stderr
          : Buffer.isBuffer(maybe.stderr)
            ? maybe.stderr.toString("utf8")
            : undefined,
        typeof maybe.message === "string" ? maybe.message : undefined,
      ]
        .filter(Boolean)
        .join("\n")
        .trim();
      return { ok: false, output };
    }
  }

  diffStat(params: { worktreePath: string; baseRef: string }): string {
    try {
      return shellGit(params.worktreePath, ["diff", "--stat", `${params.baseRef}...HEAD`]);
    } catch {
      return "";
    }
  }

  publishBranch(params: {
    repoRoot: string;
    worktreePath: string;
    branchName: string;
    remoteName?: string;
    openPullRequest?: boolean;
    baseRef: string;
    targetRef?: string;
    title: string;
    body: string;
  }): PublishBranchResult {
    this.resolveApprovedRepoRoot(params.repoRoot);
    const worktreePath = path.resolve(params.worktreePath);
    if (!isInside(this.worktreeRoot, worktreePath) || !fs.existsSync(worktreePath)) {
      throw new Error("Integration worktree is missing or outside the project worktree root.");
    }
    const remoteName = params.remoteName ?? "origin";
    const targetRef = params.targetRef ?? params.branchName;
    assertSafeBranchRef(params.branchName, "Source branch");
    assertSafeBranchRef(targetRef, "Target branch");
    const pushOutput = shellGit(worktreePath, ["push", "-u", remoteName, `${params.branchName}:${targetRef}`]);
    if (!params.openPullRequest) {
      return { pushOutput };
    }
    const pullRequestOutput = shellCommand(worktreePath, "gh", [
      "pr",
      "create",
      "--base",
      params.baseRef,
      "--head",
      params.branchName,
      "--title",
      params.title,
      "--body",
      params.body,
    ]);
    const pullRequestUrl = pullRequestOutput
      .split(/\s+/)
      .find((entry) => /^https:\/\/github\.com\/\S+\/pull\/\d+$/.test(entry));
    return {
      pushOutput,
      ...(pullRequestOutput ? { pullRequestOutput } : {}),
      ...(pullRequestUrl ? { pullRequestUrl } : {}),
    };
  }

  cleanupSubtask(params: {
    repoRoot: string;
    worktreePath?: string;
    branchName?: string;
    deleteBranch?: boolean;
  }): void {
    const repoRoot = this.resolveApprovedRepoRoot(params.repoRoot);
    if (params.worktreePath) {
      const normalizedWorktreePath = path.resolve(params.worktreePath);
      if (isInside(this.worktreeRoot, normalizedWorktreePath) && fs.existsSync(normalizedWorktreePath)) {
        try {
          shellGit(repoRoot, ["worktree", "remove", "--force", normalizedWorktreePath]);
        } catch {
          // Best-effort cleanup after force removal fallback.
        }
        fs.rmSync(normalizedWorktreePath, { recursive: true, force: true });
      }
    }
    if (params.branchName && params.deleteBranch !== false) {
      try {
        const existing = shellGit(repoRoot, ["branch", "--list", params.branchName]);
        if (existing) {
          shellGit(repoRoot, ["branch", "-D", params.branchName]);
        }
      } catch {
        // Branch may not exist yet; this cleanup remains best-effort.
      }
    }
  }

  listProtectedChanges(worktreePath: string): string[] {
    const absoluteWorktree = path.resolve(worktreePath);
    const status = shellGit(absoluteWorktree, ["status", "--porcelain"]);
    if (!status) {
      return [];
    }
    const violations = new Set<string>();
    for (const line of status.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry) {
        continue;
      }
      const relativePath = normalizeDisplayPath(
        entry
          .slice(3)
          .trim()
          .replace(/^"+|"+$/g, ""),
      );
      if (this.deniedPaths.some((spec) => matchesDeniedPath(relativePath, spec))) {
        violations.add(relativePath);
      }
    }
    return [...violations].sort();
  }

  private resolveApprovedRepoRoot(rawRepoRoot: string): string {
    const absolute = path.resolve(rawRepoRoot);
    const realPath = fs.realpathSync(absolute);
    const approved = this.repoRoots.some((repoRoot) => isInside(repoRoot, realPath));
    if (!approved) {
      throw new Error(`Repository root ${rawRepoRoot} is outside approved project roots.`);
    }
    if (!fs.existsSync(path.join(realPath, ".git"))) {
      throw new Error(`Repository root ${rawRepoRoot} must point to a git checkout.`);
    }
    return realPath;
  }
}

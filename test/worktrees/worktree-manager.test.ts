import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { WorktreeManager } from "../../src/worktrees/worktree-manager.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createRepo(root: string): void {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "mottbot@example.test"]);
  git(root, ["config", "user.name", "Mott Bot"]);
  fs.writeFileSync(path.join(root, "README.md"), "# test\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
}

describe("WorktreeManager", () => {
  it("prepares and cleans up subtask worktrees", () => {
    const root = createTempDir();
    try {
      createRepo(root);
      const manager = new WorktreeManager({
        repoRoots: [root],
        worktreeRoot: path.join(root, ".mottbot-worktrees"),
      });

      const prepared = manager.prepareSubtask({
        taskId: "task-1",
        subtaskId: "worker-1",
        repoRoot: root,
        baseRef: "main",
      });

      expect(fs.existsSync(prepared.worktreePath)).toBe(true);
      expect(git(prepared.worktreePath, ["branch", "--show-current"])).toBe(prepared.branchName);

      manager.cleanupSubtask({
        repoRoot: root,
        worktreePath: prepared.worktreePath,
        branchName: prepared.branchName,
      });

      expect(fs.existsSync(prepared.worktreePath)).toBe(false);
      expect(git(root, ["branch", "--list", prepared.branchName])).toBe("");
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects repositories outside approved roots", () => {
    const approvedRoot = createTempDir();
    const otherRoot = createTempDir();
    try {
      createRepo(approvedRoot);
      createRepo(otherRoot);
      const manager = new WorktreeManager({
        repoRoots: [approvedRoot],
        worktreeRoot: path.join(approvedRoot, ".mottbot-worktrees"),
      });

      expect(() =>
        manager.prepareSubtask({
          taskId: "task-1",
          subtaskId: "worker-1",
          repoRoot: otherRoot,
          baseRef: "main",
        }),
      ).toThrow(/outside approved project roots/);
    } finally {
      removeTempDir(approvedRoot);
      removeTempDir(otherRoot);
    }
  });

  it("rejects approved paths that are not git checkouts", () => {
    const root = createTempDir();
    try {
      createRepo(root);
      const nested = path.join(root, "not-a-repo");
      fs.mkdirSync(nested);
      const manager = new WorktreeManager({
        repoRoots: [root],
        worktreeRoot: path.join(root, ".mottbot-worktrees"),
      });

      expect(() =>
        manager.prepareSubtask({
          taskId: "task-1",
          subtaskId: "worker-1",
          repoRoot: nested,
          baseRef: "main",
        }),
      ).toThrow(/must point to a git checkout/);
    } finally {
      removeTempDir(root);
    }
  });

  it("flags protected path edits in worktrees", () => {
    const root = createTempDir();
    try {
      createRepo(root);
      const manager = new WorktreeManager({
        repoRoots: [root],
        worktreeRoot: path.join(root, ".mottbot-worktrees"),
      });
      const prepared = manager.prepareSubtask({
        taskId: "task-1",
        subtaskId: "worker-1",
        repoRoot: root,
        baseRef: "main",
      });
      fs.writeFileSync(path.join(prepared.worktreePath, ".env.local"), "TOKEN=123", "utf8");

      expect(manager.listProtectedChanges(prepared.worktreePath)).toContain(".env.local");
    } finally {
      removeTempDir(root);
    }
  });

  it("honors custom protected path patterns", () => {
    const root = createTempDir();
    const previousDeniedPaths = process.env.MOTTBOT_REPOSITORY_DENIED_PATHS;
    process.env.MOTTBOT_REPOSITORY_DENIED_PATHS = "custom.secret";
    try {
      createRepo(root);
      const manager = new WorktreeManager({
        repoRoots: [root],
        worktreeRoot: path.join(root, ".mottbot-worktrees"),
      });
      const prepared = manager.prepareSubtask({
        taskId: "task-1",
        subtaskId: "worker-1",
        repoRoot: root,
        baseRef: "main",
      });
      fs.writeFileSync(path.join(prepared.worktreePath, "custom.secret"), "secret", "utf8");

      expect(manager.listProtectedChanges(prepared.worktreePath)).toContain("custom.secret");
    } finally {
      if (previousDeniedPaths === undefined) {
        delete process.env.MOTTBOT_REPOSITORY_DENIED_PATHS;
      } else {
        process.env.MOTTBOT_REPOSITORY_DENIED_PATHS = previousDeniedPaths;
      }
      removeTempDir(root);
    }
  });

  it("reports merge and diff failures without throwing", () => {
    const root = createTempDir();
    try {
      createRepo(root);
      const manager = new WorktreeManager({
        repoRoots: [root],
        worktreeRoot: path.join(root, ".mottbot-worktrees"),
      });
      const prepared = manager.prepareIntegration({
        taskId: "task-1",
        repoRoot: root,
        baseRef: "main",
      });

      expect(manager.mergeBranch({ worktreePath: prepared.worktreePath, branchName: "missing-branch" })).toMatchObject({
        ok: false,
      });
      expect(manager.diffStat({ worktreePath: prepared.worktreePath, baseRef: "missing-ref" })).toBe("");
    } finally {
      removeTempDir(root);
    }
  });

  it("removes stale worktree directories and can preserve branches during cleanup", () => {
    const root = createTempDir();
    try {
      createRepo(root);
      const worktreeRoot = path.join(root, ".mottbot-worktrees");
      const stalePath = path.join(worktreeRoot, "task-1", "worker-1");
      fs.mkdirSync(stalePath, { recursive: true });
      fs.writeFileSync(path.join(stalePath, "stale.txt"), "stale", "utf8");
      const manager = new WorktreeManager({
        repoRoots: [root],
        worktreeRoot,
      });

      const prepared = manager.prepareSubtask({
        taskId: "task-1",
        subtaskId: "worker-1",
        repoRoot: root,
        baseRef: "main",
      });

      expect(fs.existsSync(path.join(prepared.worktreePath, "stale.txt"))).toBe(false);

      manager.cleanupSubtask({
        repoRoot: root,
        worktreePath: prepared.worktreePath,
        branchName: prepared.branchName,
        deleteBranch: false,
      });

      expect(fs.existsSync(prepared.worktreePath)).toBe(false);
      expect(git(root, ["branch", "--list", prepared.branchName])).toContain(prepared.branchName);

      manager.cleanupSubtask({ repoRoot: root, branchName: prepared.branchName });

      expect(git(root, ["branch", "--list", prepared.branchName])).toBe("");
    } finally {
      removeTempDir(root);
    }
  });

  it("pushes integration branches to the configured remote", () => {
    const root = createTempDir();
    const remote = createTempDir();
    try {
      createRepo(root);
      git(remote, ["init", "--bare", "--initial-branch=main"]);
      git(root, ["remote", "add", "origin", remote]);
      const manager = new WorktreeManager({
        repoRoots: [root],
        worktreeRoot: path.join(root, ".mottbot-worktrees"),
      });
      const prepared = manager.prepareIntegration({
        taskId: "task-1",
        repoRoot: root,
        baseRef: "main",
      });
      fs.writeFileSync(path.join(prepared.worktreePath, "README.md"), "# test\n\npublished\n", "utf8");
      git(prepared.worktreePath, ["add", "README.md"]);
      git(prepared.worktreePath, ["commit", "-m", "publish"]);

      const result = manager.publishBranch({
        repoRoot: root,
        worktreePath: prepared.worktreePath,
        branchName: prepared.branchName,
        baseRef: "main",
        title: "Task",
        body: "Body",
      });

      expect(result.pushOutput).toBeTypeOf("string");
      expect(git(root, ["ls-remote", "--heads", "origin", prepared.branchName])).toContain(prepared.branchName);
    } finally {
      removeTempDir(root);
      removeTempDir(remote);
    }
  });

  it("can publish an integration branch directly to the target branch", () => {
    const root = createTempDir();
    const remote = createTempDir();
    try {
      createRepo(root);
      git(remote, ["init", "--bare", "--initial-branch=main"]);
      git(root, ["remote", "add", "origin", remote]);
      git(root, ["push", "origin", "main:main"]);
      const manager = new WorktreeManager({
        repoRoots: [root],
        worktreeRoot: path.join(root, ".mottbot-worktrees"),
      });
      const prepared = manager.prepareIntegration({
        taskId: "task-1",
        repoRoot: root,
        baseRef: "main",
      });
      fs.writeFileSync(path.join(prepared.worktreePath, "README.md"), "# test\n\npublished to main\n", "utf8");
      git(prepared.worktreePath, ["add", "README.md"]);
      git(prepared.worktreePath, ["commit", "-m", "publish to main"]);

      manager.publishBranch({
        repoRoot: root,
        worktreePath: prepared.worktreePath,
        branchName: prepared.branchName,
        targetRef: "main",
        baseRef: "main",
        title: "Task",
        body: "Body",
      });

      expect(git(remote, ["show", "main:README.md"])).toContain("published to main");
    } finally {
      removeTempDir(root);
      removeTempDir(remote);
    }
  });

  it("rejects missing worktrees and unsafe publish refs", () => {
    const root = createTempDir();
    try {
      createRepo(root);
      const manager = new WorktreeManager({
        repoRoots: [root],
        worktreeRoot: path.join(root, ".mottbot-worktrees"),
      });
      const prepared = manager.prepareIntegration({
        taskId: "task-1",
        repoRoot: root,
        baseRef: "main",
      });

      expect(() =>
        manager.publishBranch({
          repoRoot: root,
          worktreePath: path.join(root, "missing-worktree"),
          branchName: prepared.branchName,
          baseRef: "main",
          title: "Task",
          body: "Body",
        }),
      ).toThrow("Integration worktree is missing");

      expect(() =>
        manager.publishBranch({
          repoRoot: root,
          worktreePath: prepared.worktreePath,
          branchName: "bad..branch",
          baseRef: "main",
          title: "Task",
          body: "Body",
        }),
      ).toThrow("Source branch is not a safe branch ref.");

      expect(() =>
        manager.publishBranch({
          repoRoot: root,
          worktreePath: prepared.worktreePath,
          branchName: prepared.branchName,
          targetRef: "bad..target",
          baseRef: "main",
          title: "Task",
          body: "Body",
        }),
      ).toThrow("Target branch is not a safe branch ref.");
    } finally {
      removeTempDir(root);
    }
  });

  it("captures pull request output when publishing with pr creation enabled", () => {
    const root = createTempDir();
    const remote = createTempDir();
    const previousPath = process.env.PATH;
    try {
      createRepo(root);
      git(remote, ["init", "--bare", "--initial-branch=main"]);
      git(root, ["remote", "add", "origin", remote]);
      const fakeBin = path.join(root, "bin");
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(path.join(fakeBin, "gh"), "#!/bin/sh\necho https://github.com/example/mottbot/pull/123\n", {
        mode: 0o755,
      });
      process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
      const manager = new WorktreeManager({
        repoRoots: [root],
        worktreeRoot: path.join(root, ".mottbot-worktrees"),
      });
      const prepared = manager.prepareIntegration({
        taskId: "task-1",
        repoRoot: root,
        baseRef: "main",
      });
      fs.writeFileSync(path.join(prepared.worktreePath, "README.md"), "# test\n\npublished with pr\n", "utf8");
      git(prepared.worktreePath, ["add", "README.md"]);
      git(prepared.worktreePath, ["commit", "-m", "publish with pr"]);

      const result = manager.publishBranch({
        repoRoot: root,
        worktreePath: prepared.worktreePath,
        branchName: prepared.branchName,
        baseRef: "main",
        title: "Task",
        body: "Body",
        openPullRequest: true,
      });

      expect(result.pullRequestOutput).toContain("https://github.com/example/mottbot/pull/123");
      expect(result.pullRequestUrl).toBe("https://github.com/example/mottbot/pull/123");
    } finally {
      process.env.PATH = previousPath;
      removeTempDir(root);
      removeTempDir(remote);
    }
  });
});

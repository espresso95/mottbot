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
});

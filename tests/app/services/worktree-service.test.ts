import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  getProjectsMock: vi.fn(),
  checkFolderPresenceMock: vi.fn(),
  isContainer: false,
}));

vi.mock("../../../src/app/services/project-service.js", () => ({
  getProjects: mocked.getProjectsMock,
}));

vi.mock("../../../src/app/services/folder-presence-service.js", () => ({
  checkFolderPresence: mocked.checkFolderPresenceMock,
  findMissingFolders: vi.fn(async () => new Set()),
}));

vi.mock("../../../src/runtime/container.js", () => ({
  isContainerRuntime: () => mocked.isContainer,
}));

vi.mock("node:child_process", () => ({
  execFile: mocked.execFileMock,
}));

vi.mock("node:fs/promises", () => ({
  stat: mocked.statMock,
  readFile: mocked.readFileMock,
}));

import {
  findWorktreeOwner,
  getCurrentFolderWorktreeContext,
  getGitWorktreeContext,
  resolveGitDir,
} from "../../../src/app/services/worktree-service.js";

describe("app/services/worktree-service", () => {
  beforeEach(() => {
    mocked.execFileMock.mockReset();
    mocked.statMock.mockReset();
    mocked.readFileMock.mockReset();
    mocked.getProjectsMock.mockReset();
    mocked.checkFolderPresenceMock.mockReset();
    mocked.isContainer = false;
  });

  describe("a gone worktree", () => {
    const repoPath = path.resolve("D:/repo");
    const gonePath = path.resolve("D:/repo-gone");
    const otherPath = path.resolve("D:/notes");

    beforeEach(() => {
      // Only the repository has git metadata; the gone worktree and the plain folder have none.
      mocked.statMock.mockImplementation(async (target: string) => {
        if (target === path.join(repoPath, ".git")) {
          return { isDirectory: () => true, isFile: () => false };
        }
        throw new Error("ENOENT");
      });
      mocked.execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(
            null,
            `worktree ${repoPath}
HEAD 1
branch refs/heads/main

worktree ${gonePath}
HEAD 2
branch refs/heads/gone
prunable gitdir file points to non-existent location
`,
            "",
          );
        },
      );
      mocked.getProjectsMock.mockResolvedValue([
        { id: "global", worktree: "/" },
        { id: "notes", worktree: otherPath },
        { id: "repo", worktree: repoPath },
      ]);
      mocked.checkFolderPresenceMock.mockResolvedValue("missing");
    });

    it("is owned by the repository that still lists it", async () => {
      await expect(findWorktreeOwner(gonePath)).resolves.toBe(repoPath);
    });

    it("has no owner when no repository lists it", async () => {
      await expect(findWorktreeOwner(path.resolve("D:/elsewhere"))).resolves.toBeNull();
    });

    it("has no owner when it is the repository's own main folder", async () => {
      await expect(findWorktreeOwner(repoPath)).resolves.toBeNull();
    });

    it("has no owner in a container", async () => {
      mocked.isContainer = true;

      await expect(findWorktreeOwner(gonePath)).resolves.toBeNull();
      expect(mocked.getProjectsMock).not.toHaveBeenCalled();
    });

    it("lists the owning repository's worktrees with no row marked current", async () => {
      const context = await getCurrentFolderWorktreeContext(gonePath);

      expect(context?.mainProjectPath).toBe(repoPath);
      expect(context?.worktrees.map((entry) => [entry.path, entry.isCurrent])).toEqual([
        [repoPath, false],
        [gonePath, false],
      ]);
    });

    it("keeps today's answer when the server does not confirm the folder is gone", async () => {
      mocked.checkFolderPresenceMock.mockResolvedValue("unknown");

      await expect(getCurrentFolderWorktreeContext(gonePath)).resolves.toBeNull();
      expect(mocked.getProjectsMock).not.toHaveBeenCalled();
    });
  });

  it("returns null when .git metadata is missing", async () => {
    mocked.statMock.mockRejectedValue(new Error("ENOENT"));

    await expect(resolveGitDir(path.resolve("D:/repo"))).resolves.toBeNull();
    await expect(getGitWorktreeContext(path.resolve("D:/repo"))).resolves.toBeNull();
  });

  it("resolves main worktree metadata from git worktree list", async () => {
    const repoPath = path.resolve("D:/repo");

    mocked.statMock.mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
    });
    mocked.execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          `worktree ${repoPath}\nHEAD 123\nbranch refs/heads/main\n\nworktree ${path.resolve("D:/repo-feature")}\nHEAD 456\nbranch refs/heads/feature/mobile\n`,
          "",
        );
      },
    );

    const context = await getGitWorktreeContext(repoPath);

    expect(context).toEqual({
      mainProjectPath: repoPath,
      activeWorktreePath: repoPath,
      branch: "main",
      isLinkedWorktree: false,
      worktrees: [
        { path: repoPath, branch: "main", isCurrent: true, isMain: true },
        {
          path: path.resolve("D:/repo-feature"),
          branch: "feature/mobile",
          isCurrent: false,
          isMain: false,
        },
      ],
    });
  });

  it("derives the main project path for linked worktrees", async () => {
    const mainWorktree = path.resolve("D:/repo");
    const linkedWorktree = path.resolve("D:/repo-feature");
    const linkedGitDir = path.join(mainWorktree, ".git", "worktrees", "feature");

    mocked.statMock.mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
    });
    mocked.readFileMock.mockResolvedValue(`gitdir: ${linkedGitDir}`);
    mocked.execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          `worktree ${mainWorktree}\nHEAD 123\nbranch refs/heads/main\n\nworktree ${linkedWorktree}\nHEAD 456\nbranch refs/heads/feature/worktree\n`,
          "",
        );
      },
    );

    const context = await getGitWorktreeContext(linkedWorktree);

    expect(context).toEqual({
      mainProjectPath: mainWorktree,
      activeWorktreePath: linkedWorktree,
      branch: "feature/worktree",
      isLinkedWorktree: true,
      worktrees: [
        { path: mainWorktree, branch: "main", isCurrent: false, isMain: true },
        {
          path: linkedWorktree,
          branch: "feature/worktree",
          isCurrent: true,
          isMain: false,
        },
      ],
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMissingFolderNotice } from "../../../src/app/services/missing-folder-notice-service.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  checkFolderPresenceMock: vi.fn(),
  findWorktreeOwnerMock: vi.fn(),
}));

vi.mock("../../../src/app/services/folder-presence-service.js", () => ({
  checkFolderPresence: mocked.checkFolderPresenceMock,
}));

vi.mock("../../../src/app/services/worktree-service.js", () => ({
  findWorktreeOwner: mocked.findWorktreeOwnerMock,
}));

describe("app/services/missing-folder-notice-service", () => {
  beforeEach(() => {
    mocked.checkFolderPresenceMock.mockReset().mockResolvedValue("missing");
    mocked.findWorktreeOwnerMock.mockReset().mockResolvedValue(null);
  });

  it("is null unless the server confirms the folder is gone", async () => {
    mocked.checkFolderPresenceMock.mockResolvedValue("unknown");

    expect(await getMissingFolderNotice("/repo")).toBeNull();
    expect(mocked.findWorktreeOwnerMock).not.toHaveBeenCalled();
  });

  it("points to /projects for a gone folder no repository lists as a worktree", async () => {
    expect(await getMissingFolderNotice("/repo")).toBe(
      t("bot.project_folder_missing", { path: "/repo" }),
    );
  });

  it("points to /worktree for a gone worktree of a repository that still exists", async () => {
    mocked.findWorktreeOwnerMock.mockResolvedValue("/repo");

    expect(await getMissingFolderNotice("/repo-feature")).toBe(
      t("bot.project_folder_missing_worktree", { path: "/repo-feature" }),
    );
    expect(mocked.findWorktreeOwnerMock).toHaveBeenCalledWith("/repo-feature");
  });
});

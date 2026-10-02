import { t } from "../../i18n/index.js";
import { checkFolderPresence } from "./folder-presence-service.js";
import { findWorktreeOwner } from "./worktree-service.js";

/**
 * The notice for a project folder the OpenCode server confirms is gone, or null otherwise.
 * It points to /worktree only when a still-existing repository lists the folder as one of
 * its worktrees — the same lookup /worktree then lists from — and to /projects otherwise.
 */
export async function getMissingFolderNotice(folder: string): Promise<string | null> {
  if ((await checkFolderPresence(folder)) !== "missing") {
    return null;
  }
  return (await findWorktreeOwner(folder))
    ? t("bot.project_folder_missing_worktree", { path: folder })
    : t("bot.project_folder_missing", { path: folder });
}

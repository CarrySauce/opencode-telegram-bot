export interface GitWorktreeEntry {
  path: string;
  branch: string | null;
  isCurrent: boolean;
  isMain: boolean;
}

export interface GitWorktreeContext {
  mainProjectPath: string;
  activeWorktreePath: string;
  branch: string | null;
  isLinkedWorktree: boolean;
  worktrees: GitWorktreeEntry[];
}

/** A worktree row as listed, with its position in the full git worktree list. */
export interface ListedWorktree {
  entry: GitWorktreeEntry;
  gitIndex: number;
}

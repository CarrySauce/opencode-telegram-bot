import type { ModelInfo } from "./model.js";
import type { ProjectInfo } from "./project.js";
import type { SessionDirectoryCacheInfo, SessionInfo } from "./session.js";
import type { ScheduledTask } from "./scheduled-task.js";

export type ResponseStreamingMode = "edit" | "draft";

export type PromptQueueMode = "off" | "queue" | "steer";

export interface ScheduledTaskSessionIgnoreInfo {
  sessionId: string;
  createdAt: string;
}

/** One guest conversation: the OpenCode session behind it and how replies find it again. */
export interface GuestThreadInfo {
  chatId: string;
  sessionId: string;
  directory: string;
  /** Normalized text of the bot's replies, matched against the text a reply quotes back. */
  replyKeys: string[];
  /** Chat message ids of bot replies that were replied to, for an exact match next time. */
  messageIds: number[];
  updatedAt: string;
}

export interface Settings {
  currentProject?: ProjectInfo | undefined;
  currentSession?: SessionInfo | undefined;
  currentAgent?: string | undefined;
  currentModel?: ModelInfo | undefined;
  pinnedMessageId?: number | undefined;
  ttsMode?: "off" | "all" | "auto" | undefined;
  compactOutputMode?: boolean | undefined;
  deleteCompactProgressOnFinish?: boolean | undefined;
  showThinkingContent?: boolean | undefined;
  showAssistantRunFooter?: boolean | undefined;
  pinnedDashboardEnabled?: boolean | undefined;
  responseStreamingMode?: ResponseStreamingMode | undefined;
  sendDiffFileAttachments?: boolean | undefined;
  promptQueueEnabled?: boolean | undefined;
  promptQueueMode?: PromptQueueMode | undefined;
  sessionDirectoryCache?: SessionDirectoryCacheInfo | undefined;
  scheduledTasks?: ScheduledTask[] | undefined;
  scheduledTaskSessionIgnores?: ScheduledTaskSessionIgnoreInfo[] | undefined;
  guestThreads?: GuestThreadInfo[] | undefined;
}

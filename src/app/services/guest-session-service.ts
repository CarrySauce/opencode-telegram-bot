import type { ToolState } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import { getCurrentProject, getGuestThreads, setGuestThreads } from "../stores/settings-store.js";
import type { GuestThreadInfo } from "../types/settings.js";
import {
  formatCompactToolActivity,
  formatCompactToolInfo,
} from "../formatters/summary-formatter.js";
import { getStoredAgent, resolveProjectAgent } from "./agent-selection-service.js";
import { getStoredModel } from "./model-selection-service.js";
import { waitForScheduledTaskResult } from "./scheduled-task-executor-service.js";
import { registerScheduledTaskSessionIgnore } from "./scheduled-task-session-ignore-service.js";

// Bounds on what settings.json keeps: enough to reply to anything from the last weeks of use.
const MAX_THREADS = 200;
const MAX_KEYS_PER_THREAD = 20;
// Long enough to tell replies apart, short enough that formatting further in does not matter.
const REPLY_KEY_CHARS = 64;
const MIN_PREFIX_MATCH_CHARS = 16;

/** The bot message a guest message replies to. */
export interface GuestReplyTarget {
  messageId: number;
  text: string;
}

export class GuestNoProjectError extends Error {
  constructor() {
    super("No project is selected for guest prompts");
    this.name = "GuestNoProjectError";
  }
}

const runningSessionIds = new Set<string>();

/**
 * Letters and digits of a reply, lowercased. A reply quotes back the text Telegram rendered, not
 * the Markdown the bot sent, so markup and spacing are dropped from both sides before comparing.
 */
export function guestReplyKey(text: string): string {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).join("").toLowerCase().slice(0, REPLY_KEY_CHARS);
}

function keysMatch(stored: string, quoted: string): boolean {
  if (stored === quoted) {
    return true;
  }
  const shorter = stored.length < quoted.length ? stored : quoted;
  const longer = shorter === stored ? quoted : stored;
  return shorter.length >= MIN_PREFIX_MATCH_CHARS && longer.startsWith(shorter);
}

function byRecency(left: GuestThreadInfo, right: GuestThreadInfo): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function isSameThread(left: GuestThreadInfo, right: GuestThreadInfo): boolean {
  return left.chatId === right.chatId && left.sessionId === right.sessionId;
}

/** Applies `change` to the stored copy of `thread` (or to `thread` when not stored yet). */
async function updateThread(
  thread: GuestThreadInfo,
  change: (stored: GuestThreadInfo) => Partial<GuestThreadInfo>,
): Promise<GuestThreadInfo> {
  const threads = getGuestThreads();
  const stored = threads.find((candidate) => isSameThread(candidate, thread)) ?? thread;
  const updated = { ...stored, ...change(stored), updatedAt: new Date().toISOString() };
  const others = threads.filter((candidate) => !isSameThread(candidate, thread));
  await setGuestThreads([updated, ...others].sort(byRecency).slice(0, MAX_THREADS));
  return updated;
}

function withNewest<T>(values: T[], value: T): T[] {
  return [value, ...values.filter((existing) => existing !== value)].slice(0, MAX_KEYS_PER_THREAD);
}

/**
 * The conversation a guest message continues: the one that wrote the bot message it replies to.
 * A reply to a bot message that cannot be placed continues the chat's latest conversation.
 * Returns undefined when the message starts a new conversation.
 */
export function findGuestThread(
  chatId: string,
  target: GuestReplyTarget | undefined,
): GuestThreadInfo | undefined {
  if (!target) {
    return undefined;
  }

  const threads = getGuestThreads()
    .filter((thread) => thread.chatId === chatId)
    .sort(byRecency);
  const quotedKey = guestReplyKey(target.text);
  const thread =
    threads.find((candidate) => candidate.messageIds.includes(target.messageId)) ??
    (quotedKey
      ? threads.find((candidate) => candidate.replyKeys.some((key) => keysMatch(key, quotedKey)))
      : undefined);

  if (!thread) {
    logger.debug(`[GuestSession] Reply not placed, continuing latest thread: chatId=${chatId}`);
    return threads[0];
  }

  if (!thread.messageIds.includes(target.messageId)) {
    // Later replies to the same message are found by id, whatever its text.
    updateThread(thread, (stored) => ({
      messageIds: withNewest(stored.messageIds, target.messageId),
    })).catch((error) => {
      logger.warn(`[GuestSession] Could not remember reply target: chatId=${chatId}`, error);
    });
  }

  return thread;
}

export function isGuestThreadRunning(thread: GuestThreadInfo): boolean {
  return runningSessionIds.has(thread.sessionId);
}

async function sessionExists(thread: GuestThreadInfo): Promise<boolean> {
  try {
    const { data, error } = await opencodeClient.session.get({
      sessionID: thread.sessionId,
      directory: thread.directory,
    });
    return !error && Boolean(data);
  } catch (error) {
    logger.debug(`[GuestSession] Could not load guest session ${thread.sessionId}:`, error);
    return false;
  }
}

async function createThread(chatId: string): Promise<GuestThreadInfo> {
  const project = getCurrentProject();
  if (!project?.worktree) {
    throw new GuestNoProjectError();
  }

  // No title: OpenCode names the session after its first prompt, as it does for /new.
  const { data: session, error } = await opencodeClient.session.create({
    directory: project.worktree,
  });
  if (error || !session) {
    throw error || new Error("Failed to create guest session");
  }

  logger.info(`[GuestSession] Created session ${session.id} for guest chat ${chatId}`);
  return {
    chatId,
    sessionId: session.id,
    directory: session.directory,
    replyKeys: [],
    messageIds: [],
    updatedAt: new Date().toISOString(),
  };
}

/** The session a guest turn runs in, known once it is resolved or created. */
export interface GuestSessionRef {
  sessionId: string;
  directory: string;
}

const ACTIVITY_MAX_CHARS = 128;

type SessionPartSnapshot = {
  type?: string;
  tool?: string;
  callID?: string;
  state?: ToolState;
};

/** One line describing the latest tool call of the session's running turn, if it made one. */
export async function describeGuestActivity(session: GuestSessionRef): Promise<string | null> {
  const { data: messages, error } = await opencodeClient.session.messages({
    sessionID: session.sessionId,
    directory: session.directory,
  });
  if (error || !messages) {
    return null;
  }

  // The turn's reply can span several assistant messages, one per step: look back to its prompt.
  let found: { messageId: string; part: SessionPartSnapshot } | undefined;
  for (let index = messages.length - 1; index >= 0 && !found; index -= 1) {
    const message = messages[index];
    if (!message || message.info.role !== "assistant") {
      break;
    }
    const part = [...(message.parts as SessionPartSnapshot[])]
      .reverse()
      .find((candidate) => candidate.type === "tool" && candidate.tool && candidate.state);
    if (part) {
      found = { messageId: message.info.id, part };
    }
  }
  const toolPart = found?.part;
  if (!found || !toolPart?.tool || !toolPart.state) {
    return null;
  }

  const state = toolPart.state;
  const toolInfo = {
    sessionId: session.sessionId,
    messageId: found.messageId,
    callId: toolPart.callID ?? "",
    tool: toolPart.tool,
    state,
    input: state.input,
    title: "title" in state ? state.title : undefined,
    metadata: "metadata" in state ? state.metadata : undefined,
  };
  return (
    formatCompactToolActivity(toolInfo, ACTIVITY_MAX_CHARS) ??
    formatCompactToolInfo(toolInfo, ACTIVITY_MAX_CHARS, toolInfo.tool)
  );
}

/**
 * Runs one guest prompt to completion and returns the assistant's reply text. Continues
 * `thread` while its session still exists, otherwise starts a new session in the current project.
 * `onSessionReady` hears which session that is before the prompt is sent.
 */
export async function runGuestPrompt(
  chatId: string,
  thread: GuestThreadInfo | undefined,
  text: string,
  onSessionReady?: (session: GuestSessionRef) => void,
): Promise<string> {
  // Claimed before the first await, so a reply arriving right behind this one sees it running.
  let claimedSessionId = thread?.sessionId;
  if (claimedSessionId) {
    runningSessionIds.add(claimedSessionId);
  }

  try {
    let current = thread && (await sessionExists(thread)) ? thread : undefined;
    if (!current) {
      current = await createThread(chatId);
      if (claimedSessionId) {
        runningSessionIds.delete(claimedSessionId);
      }
      claimedSessionId = current.sessionId;
      runningSessionIds.add(claimedSessionId);
    }
    // Saved before the run, so a reply to the placeholder already finds this conversation.
    current = await updateThread(current, () => ({}));
    // Keeps background session tracking from mirroring the guest turn into the private chat.
    await registerScheduledTaskSessionIgnore(current.sessionId);
    onSessionReady?.({ sessionId: current.sessionId, directory: current.directory });

    const agent = await resolveProjectAgent(getStoredAgent());
    const model = getStoredModel();
    const { error } = await opencodeClient.session.promptAsync({
      sessionID: current.sessionId,
      directory: current.directory,
      parts: [{ type: "text", text }],
      agent,
      ...(model.providerID && model.modelID
        ? { model: { providerID: model.providerID, modelID: model.modelID } }
        : {}),
      ...(model.variant ? { variant: model.variant } : {}),
    });
    if (error) {
      throw error;
    }

    const reply = await waitForScheduledTaskResult(
      `guest:${chatId}`,
      current.sessionId,
      current.directory,
    );
    const replyKey = guestReplyKey(reply);
    if (replyKey) {
      await updateThread(current, (stored) => ({
        replyKeys: withNewest(stored.replyKeys, replyKey),
      }));
    }
    return reply;
  } finally {
    if (claimedSessionId) {
      runningSessionIds.delete(claimedSessionId);
    }
  }
}

export function __resetGuestSessionsForTests(): void {
  runningSessionIds.clear();
}

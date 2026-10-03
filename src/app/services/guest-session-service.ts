import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import { getCurrentProject, getGuestSession, setGuestSession } from "../stores/settings-store.js";
import type { GuestSessionInfo } from "../types/settings.js";
import { getStoredAgent, resolveProjectAgent } from "./agent-selection-service.js";
import { getStoredModel } from "./model-selection-service.js";
import { waitForScheduledTaskResult } from "./scheduled-task-executor-service.js";
import { registerScheduledTaskSessionIgnore } from "./scheduled-task-session-ignore-service.js";

export class GuestNoProjectError extends Error {
  constructor() {
    super("No project is selected for guest prompts");
    this.name = "GuestNoProjectError";
  }
}

async function isSessionReusable(session: GuestSessionInfo, directory: string): Promise<boolean> {
  if (session.directory !== directory) {
    return false;
  }

  try {
    const { data, error } = await opencodeClient.session.get({
      sessionID: session.sessionId,
      directory: session.directory,
    });
    return !error && Boolean(data);
  } catch (error) {
    logger.debug(`[GuestSession] Could not load guest session ${session.sessionId}:`, error);
    return false;
  }
}

/**
 * The session a guest chat talks to: the one it used before while it still exists in the
 * current project, otherwise a new one.
 */
async function resolveGuestSession(chatId: string, chatTitle: string): Promise<GuestSessionInfo> {
  const project = getCurrentProject();
  if (!project?.worktree) {
    throw new GuestNoProjectError();
  }

  const stored = getGuestSession(chatId);
  if (stored && (await isSessionReusable(stored, project.worktree))) {
    return stored;
  }

  const { data: session, error } = await opencodeClient.session.create({
    directory: project.worktree,
    title: `Guest: ${chatTitle}`,
  });
  if (error || !session) {
    throw error || new Error("Failed to create guest session");
  }

  const guestSession = { sessionId: session.id, directory: session.directory };
  await setGuestSession(chatId, guestSession);
  logger.info(`[GuestSession] Created session ${session.id} for guest chat ${chatId}`);
  return guestSession;
}

/** Runs one guest prompt to completion and returns the assistant's reply text. */
export async function runGuestPrompt(
  chatId: string,
  chatTitle: string,
  text: string,
): Promise<string> {
  const session = await resolveGuestSession(chatId, chatTitle);
  // Keeps background session tracking from mirroring the guest turn into the private chat.
  await registerScheduledTaskSessionIgnore(session.sessionId);

  const agent = await resolveProjectAgent(getStoredAgent());
  const model = getStoredModel();
  const { error } = await opencodeClient.session.promptAsync({
    sessionID: session.sessionId,
    directory: session.directory,
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

  return waitForScheduledTaskResult(`guest:${chatId}`, session.sessionId, session.directory);
}

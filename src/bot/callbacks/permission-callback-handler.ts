import type { Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import type { PermissionReply } from "../../app/types/permission.js";
import { opencodeClient, opencodeServerVersion } from "../../opencode/client.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import {
  applyPermissionPromptChanges,
  clearPermissionInteraction,
  showPermissionDeliveryWarning,
} from "../menus/permission-menu.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function isPermissionReply(value: string): value is PermissionReply {
  return value === "once" || value === "always" || value === "reject";
}

function isPermissionRequestNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    _tag?: unknown;
    name?: unknown;
    message?: unknown;
    data?: { message?: unknown };
  };

  if (candidate._tag === "PermissionNotFoundError") {
    return true;
  }

  if (candidate.name === "NotFoundError") {
    return true;
  }

  return [candidate.message, candidate.data?.message].some(
    (message) =>
      typeof message === "string" && message.toLowerCase().includes("permission request not found"),
  );
}

export type PermissionCallbackDeps = Pick<
  AppContainer,
  "interactionManager" | "permissionManager" | "summaryAggregator"
>;

export async function handlePermissionCallback(
  ctx: Context,
  deps: PermissionCallbackDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) return false;

  if (!data.startsWith("permission:")) {
    return false;
  }

  logger.debug(`[PermissionHandler] Received callback: ${data}`);

  if (!deps.permissionManager.isActive()) {
    clearPermissionInteraction("permission_inactive_callback", deps);
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const callbackMessageId = getCallbackMessageId(ctx);
  if (!deps.permissionManager.isActiveMessage(callbackMessageId)) {
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const requestIDs = deps.permissionManager.getRequestIDs(callbackMessageId);
  if (requestIDs.length === 0) {
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const parts = data.split(":");
  const action = parts[1];

  if (!action || !isPermissionReply(action)) {
    await ctx.answerCallbackQuery({
      text: t("permission.processing_error_callback"),
      show_alert: true,
    });
    return true;
  }

  try {
    await handlePermissionReply(ctx, deps, action, requestIDs, callbackMessageId);
  } catch (err) {
    logger.error("[PermissionHandler] Error handling callback:", err);
    await ctx.answerCallbackQuery({
      text: t("permission.processing_error_callback"),
      show_alert: true,
    });
  }

  return true;
}

async function handlePermissionReply(
  ctx: Context,
  deps: PermissionCallbackDeps,
  reply: PermissionReply,
  requestIDs: string[],
  callbackMessageId: number | null,
): Promise<void> {
  const currentProject = getCurrentProject();
  const currentSession = getCurrentSession();
  const chatId = ctx.chat?.id;
  const directory = currentSession?.directory ?? currentProject?.worktree;

  if (!directory || !chatId) {
    deps.permissionManager.clear();
    clearPermissionInteraction("permission_invalid_runtime_context", deps);

    await ctx.answerCallbackQuery({
      text: t("permission.no_active_request_callback"),
      show_alert: true,
    });
    return;
  }

  const replyLabels: Record<PermissionReply, string> = {
    once: t("permission.reply.once"),
    always: t("permission.reply.always"),
    reject: t("permission.reply.reject"),
  };

  // On V2 a reject settles every pending request of the session.
  const settlesSession = reply === "reject" && opencodeServerVersion === "v2";
  if (
    callbackMessageId === null ||
    !deps.permissionManager.markSending(callbackMessageId, reply, settlesSession)
  ) {
    // The first answer is still on its way: a second tap changes nothing.
    await ctx.answerCallbackQuery();
    return;
  }

  // The answer is marked as being sent: a lost toast must not keep it from going out.
  await ctx.answerCallbackQuery({ text: replyLabels[reply] }).catch((err) => {
    logger.warn("[PermissionHandler] Failed to answer the permission callback:", err);
  });

  deps.summaryAggregator.stopTypingIndicator();

  logger.info(
    `[PermissionHandler] Sending permission reply: ${reply}, requestIDs=${requestIDs.join(",")}`,
  );

  const messageId = callbackMessageId;
  const sessionID = deps.permissionManager.getRequest(messageId)?.sessionID ?? null;

  safeBackgroundTask({
    taskName: "permission.reply",
    task: async () => {
      const results: PermissionReplyResults = { accepted: [], gone: [], failed: [] };

      for (const requestID of requestIDs) {
        const response = await opencodeClient.permission.reply({
          requestID,
          directory,
          reply,
        });

        if (!response.error) {
          results.accepted.push(requestID);
        } else if (isPermissionRequestNotFound(response.error)) {
          logger.debug(
            `[PermissionHandler] Permission request already resolved: requestID=${requestID}`,
          );
          results.gone.push(requestID);
        } else {
          logger.error(
            `[PermissionHandler] Failed to send permission reply: requestID=${requestID}`,
            response.error,
          );
          results.failed.push(requestID);
        }
      }

      return results;
    },
    onSuccess: (results) => {
      void finishPermissionReply(ctx.api, chatId, deps, {
        messageId,
        sessionID,
        reply,
        settlesSession,
        results,
      });
    },
    onError: () => {
      void finishPermissionReply(ctx.api, chatId, deps, {
        messageId,
        sessionID,
        reply,
        settlesSession,
        results: { accepted: [], gone: [], failed: requestIDs },
      });
    },
  });
}

interface PermissionReplyResults {
  accepted: string[];
  gone: string[];
  failed: string[];
}

interface FinishedPermissionReply {
  messageId: number;
  sessionID: string | null;
  reply: PermissionReply;
  settlesSession: boolean;
  results: PermissionReplyResults;
}

/**
 * Ends the prompt once OpenCode took the answer, or leaves it answerable with a warning
 * when the answer did not get through. A prompt an event or a reset already ended stays
 * as it is.
 */
async function finishPermissionReply(
  api: Context["api"],
  chatId: number,
  deps: PermissionCallbackDeps,
  finished: FinishedPermissionReply,
): Promise<void> {
  const { messageId, sessionID, reply, settlesSession, results } = finished;

  try {
    if (results.failed.length > 0) {
      const change = deps.permissionManager.failSending(messageId, results.accepted);
      if (change && change.outcome) {
        await applyPermissionPromptChanges(api, chatId, [change], deps);
      } else if (change) {
        await showPermissionDeliveryWarning(api, chatId, change, deps);
      }
      return;
    }

    const answered = results.accepted.length > 0;
    const change = deps.permissionManager.endPrompt(
      messageId,
      answered ? { kind: "replied", reply, outside: false } : { kind: "settled_outside" },
    );
    const changes = change ? [change] : [];

    if (answered && settlesSession && sessionID) {
      changes.push(
        ...deps.permissionManager.endSessionPrompts(sessionID, {
          kind: "replied",
          reply: "reject",
          outside: false,
        }),
      );
    }

    await applyPermissionPromptChanges(api, chatId, changes, deps);
    logger.info(`[PermissionHandler] Permission reply finished: messageId=${messageId}`);
  } catch (err) {
    logger.error("[PermissionHandler] Failed to finish permission reply:", err);
  }
}

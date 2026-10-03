import type { Api, Context } from "grammy";
import type { InlineQueryResultArticle } from "grammy/types";
import { config } from "../../config.js";
import { formatDuration } from "../../app/formatters/duration-formatter.js";
import { GuestNoProjectError, runGuestPrompt } from "../../app/services/guest-session-service.js";
import { ScheduledTaskInteractiveRequestError } from "../../app/services/scheduled-task-executor-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { convertToTelegramMarkdownV2 } from "../render/markdown-to-telegram-v2.js";
import { TELEGRAM_TEXT_MESSAGE_LIMIT } from "../render/limits.js";
import { isTelegramBadRequestError } from "../messages/send-with-markdown-fallback.js";

// A guest chat has exactly one message the bot may write to, so progress is shown by editing it.
const PROGRESS_INTERVAL_MS = 15_000;

// One running turn per guest chat: a second mention would have no message of its own to answer on
// once the first has spent the chat's placeholder, and the two would race on one session.
const activeGuestChats = new Set<string>();

function textArticle(text: string): InlineQueryResultArticle {
  return {
    type: "article",
    id: "reply",
    title: text.slice(0, 64),
    input_message_content: { message_text: text },
  };
}

function stripBotMention(text: string, botUsername: string | undefined): string {
  if (!botUsername) {
    return text.trim();
  }
  return text.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
}

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_TEXT_MESSAGE_LIMIT) {
    return text;
  }
  const notice = `\n\n${t("guest.truncated")}`;
  return `${text.slice(0, TELEGRAM_TEXT_MESSAGE_LIMIT - notice.length - 1)}…${notice}`;
}

async function editGuestMessage(api: Api, inlineMessageId: string, text: string): Promise<void> {
  await api.editMessageTextInline(inlineMessageId, truncateForTelegram(text));
}

async function editGuestReply(api: Api, inlineMessageId: string, reply: string): Promise<void> {
  if (config.bot.messageFormatMode === "markdown") {
    const markdown = convertToTelegramMarkdownV2(reply);
    if (markdown && markdown.length <= TELEGRAM_TEXT_MESSAGE_LIMIT) {
      try {
        await api.editMessageTextInline(inlineMessageId, markdown, { parse_mode: "MarkdownV2" });
        return;
      } catch (error) {
        if (!isTelegramBadRequestError(error)) {
          throw error;
        }
        logger.debug("[Guest] MarkdownV2 reply rejected, falling back to plain text", error);
      }
    }
  }

  await editGuestMessage(api, inlineMessageId, reply);
}

function describeGuestError(error: unknown): string {
  if (error instanceof GuestNoProjectError) {
    return t("guest.error.no_project");
  }
  if (error instanceof ScheduledTaskInteractiveRequestError) {
    return t("guest.error.interactive");
  }
  return t("guest.error.generic");
}

/** Runs the prompt and keeps the guest placeholder up to date until the reply replaces it. */
export async function runGuestTurn(
  api: Api,
  inlineMessageId: string,
  chatId: string,
  chatTitle: string,
  text: string,
): Promise<void> {
  const startedAt = Date.now();
  const progressTimer = setInterval(() => {
    const elapsed = formatDuration(Date.now() - startedAt);
    editGuestMessage(api, inlineMessageId, t("guest.working", { elapsed })).catch((error) => {
      logger.debug(`[Guest] Progress edit failed: chatId=${chatId}`, error);
    });
  }, PROGRESS_INTERVAL_MS);

  try {
    const reply = await runGuestPrompt(chatId, chatTitle, text);
    clearInterval(progressTimer);
    await editGuestReply(api, inlineMessageId, reply);
    logger.info(`[Guest] Turn completed: chatId=${chatId}`);
  } catch (error) {
    clearInterval(progressTimer);
    logger.error(`[Guest] Turn failed: chatId=${chatId}`, error);
    await editGuestMessage(api, inlineMessageId, describeGuestError(error)).catch((editError) => {
      logger.warn(`[Guest] Could not report failure: chatId=${chatId}`, editError);
    });
  } finally {
    activeGuestChats.delete(chatId);
  }
}

async function answerWithText(ctx: Context, guestQueryId: string, text: string): Promise<void> {
  try {
    await ctx.api.answerGuestQuery(guestQueryId, textArticle(text));
  } catch (error) {
    logger.warn("[Guest] Could not answer guest query", error);
  }
}

/**
 * Handles an @mention from a chat the bot never joined (Telegram guest bots, Bot API 10.0).
 * The caller was already authorized by the auth middleware. The one-shot guest query is spent on
 * a placeholder, which is then edited into the reply once OpenCode finishes.
 */
export async function handleGuestMessage(ctx: Context): Promise<void> {
  const message = ctx.guestMessage;
  const guestQueryId = message?.guest_query_id;
  if (!message || !guestQueryId) {
    return;
  }

  const chatId = String(message.chat.id);
  const text = stripBotMention(message.text ?? "", ctx.me?.username);

  if (message.text === undefined) {
    await answerWithText(ctx, guestQueryId, t("guest.unsupported_message"));
    return;
  }
  if (!text) {
    await answerWithText(ctx, guestQueryId, t("guest.empty"));
    return;
  }
  if (text.startsWith("/")) {
    await answerWithText(ctx, guestQueryId, t("guest.command_unsupported"));
    return;
  }
  if (activeGuestChats.has(chatId)) {
    await answerWithText(ctx, guestQueryId, t("guest.busy"));
    return;
  }

  activeGuestChats.add(chatId);
  let inlineMessageId: string;
  try {
    const sent = await ctx.api.answerGuestQuery(guestQueryId, textArticle(t("guest.thinking")));
    inlineMessageId = sent.inline_message_id;
  } catch (error) {
    activeGuestChats.delete(chatId);
    logger.warn(`[Guest] Could not post placeholder: chatId=${chatId}`, error);
    return;
  }

  const chatTitle = "title" in message.chat && message.chat.title ? message.chat.title : chatId;
  logger.info(`[Guest] Turn started: chatId=${chatId}, length=${text.length}`);

  // Long polling handles updates one at a time, so the turn must not hold up the update loop.
  safeBackgroundTask({
    taskName: "guest.turn",
    task: () => runGuestTurn(ctx.api, inlineMessageId, chatId, chatTitle, text),
  });
}

export function __resetGuestMessageHandlerForTests(): void {
  activeGuestChats.clear();
}

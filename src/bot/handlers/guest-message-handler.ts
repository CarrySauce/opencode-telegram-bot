import type { Api, Context } from "grammy";
import type { InlineKeyboardMarkup, InlineQueryResultArticle, Message } from "grammy/types";
import { config } from "../../config.js";
import { formatDuration } from "../../app/formatters/duration-formatter.js";
import {
  connectGuestThread,
  describeGuestActivity,
  findGuestThread,
  GuestNoProjectError,
  GuestNoReplyError,
  isGuestThreadRunning,
  runGuestPrompt,
  searchGuestSessions,
  watchGuestSession,
  type GuestReplyTarget,
  type GuestSessionRef,
  type GuestTurnHooks,
} from "../../app/services/guest-session-service.js";
import type { PendingInteractiveRequest } from "../../app/services/scheduled-task-executor-service.js";
import type { SessionInfo } from "../../app/types/session.js";
import type { GuestThreadInfo } from "../../app/types/settings.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { convertToTelegramMarkdownV2 } from "../render/markdown-to-telegram-v2.js";
import { TELEGRAM_TEXT_MESSAGE_LIMIT } from "../render/limits.js";
import { isTelegramBadRequestError } from "../messages/send-with-markdown-fallback.js";
import {
  answerGuestQuestionWithText,
  closeGuestPrompt,
  isGuestPromptShown,
  showGuestPrompt,
} from "./guest-prompts.js";

// A guest chat has exactly one message the bot may write to, so progress is shown by editing it.
const PROGRESS_INTERVAL_MS = 10_000;

// Conversations in one guest chat run side by side, up to this many at once.
const MAX_CONCURRENT_TURNS_PER_CHAT = 3;

const activeTurnsByChat = new Map<string, number>();

function changeActiveTurns(chatId: string, delta: number): void {
  const count = (activeTurnsByChat.get(chatId) ?? 0) + delta;
  if (count > 0) {
    activeTurnsByChat.set(chatId, count);
  } else {
    activeTurnsByChat.delete(chatId);
  }
}

// `@bot connect <search>` lists sessions to continue in the guest chat; a tap carries this prefix.
const CONNECT_PATTERN = /^connect(?:\s+([\s\S]*))?$/i;
export const GUEST_CONNECT_CALLBACK_PREFIX = "gcon:";
const CONNECT_CANCEL_CALLBACK = `${GUEST_CONNECT_CALLBACK_PREFIX}cancel`;
const CONNECT_BUTTON_TITLE_CHARS = 40;
// Session lists waiting for a tap, by the inline message they are drawn on. In memory: after a
// restart a tap is answered as expired and the list is asked for again.
const MAX_PENDING_CONNECTS = 50;

interface PendingConnect {
  chatId: string;
  sessions: SessionInfo[];
}

const pendingConnects = new Map<string, PendingConnect>();

function textArticle(text: string, replyMarkup?: InlineKeyboardMarkup): InlineQueryResultArticle {
  return {
    type: "article",
    id: "reply",
    title: text.slice(0, 64),
    input_message_content: { message_text: text },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
}

function folderName(directory: string): string {
  return directory.split(/[\\/]/).filter(Boolean).pop() ?? directory;
}

function connectButtonLabel(session: SessionInfo): string {
  const title =
    session.title.length > CONNECT_BUTTON_TITLE_CHARS
      ? `${session.title.slice(0, CONNECT_BUTTON_TITLE_CHARS - 1)}…`
      : session.title;
  return `${title} · ${folderName(session.directory)}`;
}

function stripBotMention(text: string, botUsername: string | undefined): string {
  if (!botUsername) {
    return text.trim();
  }
  return text.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
}

function isBotMessage(message: Message, botId: number | undefined): boolean {
  // A guest bot's message is sent on the caller's behalf "via" the bot.
  return botId !== undefined && (message.from?.id === botId || message.via_bot?.id === botId);
}

/** The bot message this guest message replies to, if it replies to one. */
function getBotReplyTarget(
  message: Message,
  botId: number | undefined,
): GuestReplyTarget | undefined {
  const replied = message.reply_to_message;
  if (!replied || !isBotMessage(replied, botId)) {
    return undefined;
  }
  return { messageId: replied.message_id, text: replied.text ?? replied.caption ?? "" };
}

function getAuthorName(message: Message): string | undefined {
  if (message.from) {
    return [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  }
  return message.sender_chat && "title" in message.sender_chat
    ? message.sender_chat.title
    : undefined;
}

/**
 * The message the request replies to, when it is someone's message rather than the bot's: OpenCode
 * cannot see the guest chat, so the request would otherwise lose what it refers to.
 */
function getQuotedContext(message: Message, botId: number | undefined): string | undefined {
  const replied = message.reply_to_message;
  if (!replied || isBotMessage(replied, botId)) {
    return undefined;
  }
  // A quote of part of the message is what the user pointed at; otherwise the whole message.
  const quoted = (message.quote?.text ?? replied.text ?? replied.caption ?? "").trim();
  if (!quoted) {
    return undefined;
  }
  const author = getAuthorName(replied);
  const heading = author
    ? `Message from ${author} this request replies to:`
    : "Message this request replies to:";
  return `${heading}\n"""\n${quoted}\n"""`;
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
  if (error instanceof GuestNoReplyError) {
    return t("guest.connect.no_reply");
  }
  return t("guest.error.generic");
}

type GuestTurnRunner = (hooks: GuestTurnHooks) => Promise<string>;

/** Runs a guest turn and keeps the guest placeholder up to date until the reply replaces it. */
export async function runGuestTurn(
  api: Api,
  inlineMessageId: string,
  chatId: string,
  runTurn: GuestTurnRunner,
): Promise<void> {
  const startedAt = Date.now();
  let session: GuestSessionRef | undefined;
  let finished = false;
  let progressTick: Promise<void> | undefined;

  const showProgress = async (): Promise<void> => {
    const activity = session
      ? await describeGuestActivity(session).catch((error: unknown) => {
          logger.debug(`[Guest] Could not read session activity: chatId=${chatId}`, error);
          return null;
        })
      : null;
    // A question drawn on the message stays until it is answered.
    if (finished || isGuestPromptShown(inlineMessageId)) {
      return;
    }
    const working = t("guest.working", { elapsed: formatDuration(Date.now() - startedAt) });
    await editGuestMessage(api, inlineMessageId, activity ? `${working}\n\n${activity}` : working);
  };

  const progressTimer = setInterval(() => {
    // A slow tick is skipped over rather than queued behind.
    progressTick ??= showProgress()
      .catch((error: unknown) => {
        logger.debug(`[Guest] Progress edit failed: chatId=${chatId}`, error);
      })
      .finally(() => {
        progressTick = undefined;
      });
  }, PROGRESS_INTERVAL_MS);

  // A progress edit still in flight must not land on top of the reply.
  const stopProgress = async (): Promise<void> => {
    finished = true;
    clearInterval(progressTimer);
    closeGuestPrompt(inlineMessageId);
    await progressTick;
  };

  // Requests drawn once are not drawn again while OpenCode still lists them after an answer.
  const drawnRequestIds = new Set<string>();
  let shownRequestId: string | undefined;
  const onInteractiveRequest = async (pending: PendingInteractiveRequest | null): Promise<void> => {
    if (finished || !session) {
      return;
    }
    if (!pending) {
      // Answered elsewhere (the private chat, the TUI): back to progress right away.
      if (shownRequestId && closeGuestPrompt(inlineMessageId)) {
        await editGuestMessage(
          api,
          inlineMessageId,
          t("guest.working", { elapsed: formatDuration(Date.now() - startedAt) }),
        ).catch(() => {});
      }
      shownRequestId = undefined;
      return;
    }
    if (drawnRequestIds.has(pending.request.id)) {
      return;
    }
    drawnRequestIds.add(pending.request.id);
    shownRequestId = pending.request.id;
    await progressTick;
    await showGuestPrompt(api, inlineMessageId, session, pending).catch((error: unknown) => {
      logger.warn(`[Guest] Could not show ${pending.kind}: chatId=${chatId}`, error);
    });
  };

  try {
    const reply = await runTurn({
      onSessionReady: (readySession) => {
        session = readySession;
      },
      onInteractiveRequest,
    });
    await stopProgress();
    await editGuestReply(api, inlineMessageId, reply);
    logger.info(`[Guest] Turn completed: chatId=${chatId}`);
  } catch (error) {
    await stopProgress();
    logger.error(`[Guest] Turn failed: chatId=${chatId}`, error);
    await editGuestMessage(api, inlineMessageId, describeGuestError(error)).catch((editError) => {
      logger.warn(`[Guest] Could not report failure: chatId=${chatId}`, editError);
    });
  } finally {
    changeActiveTurns(chatId, -1);
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
  const request = stripBotMention(message.text ?? "", ctx.me?.username);
  const quotedContext = getQuotedContext(message, ctx.me?.id);

  if (message.text === undefined) {
    await answerWithText(ctx, guestQueryId, t("guest.unsupported_message"));
    return;
  }
  // A bare mention in reply to a message is a request about that message.
  if (!request && !quotedContext) {
    await answerWithText(ctx, guestQueryId, t("guest.empty"));
    return;
  }
  if (request.startsWith("/")) {
    await answerWithText(ctx, guestQueryId, t("guest.command_unsupported"));
    return;
  }

  const connectMatch = CONNECT_PATTERN.exec(request);
  if (connectMatch) {
    await offerSessionsToConnect(ctx, guestQueryId, chatId, connectMatch[1]?.trim() ?? "");
    return;
  }

  const text = [quotedContext, request].filter(Boolean).join("\n\n");

  // A reply to one of the bot's messages continues that conversation; anything else starts one.
  const thread = findGuestThread(chatId, getBotReplyTarget(message, ctx.me?.id));
  if (thread && isGuestThreadRunning(thread)) {
    // While the conversation waits on its question, a reply into it is the typed answer.
    const answered = await answerGuestQuestionWithText(ctx.api, thread.sessionId, text);
    await answerWithText(ctx, guestQueryId, answered ?? t("guest.busy"));
    return;
  }
  if ((activeTurnsByChat.get(chatId) ?? 0) >= MAX_CONCURRENT_TURNS_PER_CHAT) {
    await answerWithText(ctx, guestQueryId, t("guest.too_many"));
    return;
  }

  changeActiveTurns(chatId, 1);
  let inlineMessageId: string;
  try {
    const sent = await ctx.api.answerGuestQuery(guestQueryId, textArticle(t("guest.thinking")));
    inlineMessageId = sent.inline_message_id;
  } catch (error) {
    changeActiveTurns(chatId, -1);
    logger.warn(`[Guest] Could not post placeholder: chatId=${chatId}`, error);
    return;
  }

  logger.info(
    `[Guest] Turn started: chatId=${chatId}, sessionId=${thread?.sessionId ?? "new"}, length=${text.length}`,
  );

  // Long polling handles updates one at a time, so the turn must not hold up the update loop.
  safeBackgroundTask({
    taskName: "guest.turn",
    task: () =>
      runGuestTurn(ctx.api, inlineMessageId, chatId, (hooks) =>
        runGuestPrompt(chatId, thread, text, hooks),
      ),
  });
}

/** Answers `connect <search>` with the matching sessions as buttons. */
async function offerSessionsToConnect(
  ctx: Context,
  guestQueryId: string,
  chatId: string,
  query: string,
): Promise<void> {
  let sessions: SessionInfo[];
  try {
    sessions = await searchGuestSessions(query);
  } catch (error) {
    logger.error(`[Guest] Session search failed: chatId=${chatId}`, error);
    await answerWithText(ctx, guestQueryId, t("guest.error.generic"));
    return;
  }

  if (sessions.length === 0) {
    await answerWithText(ctx, guestQueryId, t("guest.connect.none", { query }));
    return;
  }

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      ...sessions.map((session, index) => [
        {
          text: connectButtonLabel(session),
          callback_data: `${GUEST_CONNECT_CALLBACK_PREFIX}${index}`,
        },
      ]),
      [{ text: t("guest.connect.cancel"), callback_data: CONNECT_CANCEL_CALLBACK }],
    ],
  };
  try {
    const sent = await ctx.api.answerGuestQuery(
      guestQueryId,
      textArticle(t("guest.connect.pick"), keyboard),
    );
    pendingConnects.set(sent.inline_message_id, { chatId, sessions });
    while (pendingConnects.size > MAX_PENDING_CONNECTS) {
      pendingConnects.delete(pendingConnects.keys().next().value as string);
    }
    logger.info(`[Guest] Offered ${sessions.length} sessions to connect: chatId=${chatId}`);
  } catch (error) {
    logger.warn(`[Guest] Could not offer sessions to connect: chatId=${chatId}`, error);
  }
}

/**
 * A tap on a session from `connect`. Only the owner gets here: the auth middleware drops anyone
 * else's tap. The list message becomes the connected session's progress, then its reply.
 */
export async function handleGuestConnectCallback(ctx: Context): Promise<void> {
  const inlineMessageId = ctx.callbackQuery?.inline_message_id;
  if (ctx.callbackQuery?.data === CONNECT_CANCEL_CALLBACK) {
    await cancelConnect(ctx, inlineMessageId);
    return;
  }
  const index = Number((ctx.callbackQuery?.data ?? "").slice(GUEST_CONNECT_CALLBACK_PREFIX.length));
  const pending = inlineMessageId ? pendingConnects.get(inlineMessageId) : undefined;
  const session = pending?.sessions[index];
  if (!inlineMessageId || !pending || !session) {
    await ctx.answerCallbackQuery({ text: t("guest.connect.expired") }).catch(() => {});
    return;
  }

  const { chatId } = pending;
  if ((activeTurnsByChat.get(chatId) ?? 0) >= MAX_CONCURRENT_TURNS_PER_CHAT) {
    await ctx.answerCallbackQuery({ text: t("guest.too_many") }).catch(() => {});
    return;
  }

  pendingConnects.delete(inlineMessageId);
  await ctx.answerCallbackQuery().catch(() => {});

  let thread: GuestThreadInfo;
  try {
    thread = await connectGuestThread(chatId, session);
  } catch (error) {
    logger.error(`[Guest] Could not connect session: chatId=${chatId}`, error);
    await editGuestMessage(ctx.api, inlineMessageId, t("guest.error.generic")).catch(() => {});
    return;
  }
  if (isGuestThreadRunning(thread)) {
    await editGuestMessage(ctx.api, inlineMessageId, t("guest.busy")).catch(() => {});
    return;
  }

  changeActiveTurns(chatId, 1);
  await editGuestMessage(
    ctx.api,
    inlineMessageId,
    t("guest.connect.connecting", { title: session.title }),
  ).catch((error) => {
    logger.debug(`[Guest] Could not show connecting state: chatId=${chatId}`, error);
  });
  logger.info(`[Guest] Session connected: chatId=${chatId}, sessionId=${session.id}`);

  safeBackgroundTask({
    taskName: "guest.connect",
    task: () =>
      runGuestTurn(ctx.api, inlineMessageId, chatId, (hooks) =>
        watchGuestSession(chatId, thread, hooks),
      ),
  });
}

/**
 * Cancel on a session list. A bot cannot delete an inline message, so the list collapses into a
 * one-line note instead. Works on a list from before a restart too: there is nothing to undo.
 */
async function cancelConnect(ctx: Context, inlineMessageId: string | undefined): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!inlineMessageId) {
    return;
  }
  pendingConnects.delete(inlineMessageId);
  await editGuestMessage(ctx.api, inlineMessageId, t("guest.connect.cancelled")).catch((error) => {
    logger.debug("[Guest] Could not cancel the session list", error);
  });
}

export function __resetGuestMessageHandlerForTests(): void {
  activeTurnsByChat.clear();
  pendingConnects.clear();
}

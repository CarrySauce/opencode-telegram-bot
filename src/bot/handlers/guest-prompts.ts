import type { Api, Context } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import {
  answerGuestQuestion,
  dismissGuestQuestion,
  replyGuestPermission,
  type GuestSessionRef,
} from "../../app/services/guest-session-service.js";
import type { PendingInteractiveRequest } from "../../app/services/scheduled-task-executor-service.js";
import type { PermissionReply, PermissionRequest } from "../../app/types/permission.js";
import type { Question } from "../../app/types/question.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { formatPermissionText } from "../menus/permission-menu.js";

// A question or permission a guest turn waits on is drawn on the turn's own message, the one
// message the bot may write in a guest chat. Taps come back as callbacks on that inline message.
export const GUEST_PROMPT_CALLBACK_PREFIX = "gq:";
const OPTION_LABEL_CHARS = 48;
const ANSWER_SUMMARY_CHARS = 200;
const PERMISSION_REPLIES: PermissionReply[] = ["once", "always", "reject"];

interface PromptBase {
  inlineMessageId: string;
  sessionId: string;
  directory: string;
  requestId: string;
  /** An answer is on its way to OpenCode; further taps wait for it. */
  sending: boolean;
}

interface QuestionPrompt extends PromptBase {
  kind: "question";
  questions: Question[];
  index: number;
  answers: string[][];
  selected: Set<number>;
}

interface PermissionPrompt extends PromptBase {
  kind: "permission";
  request: PermissionRequest;
}

type GuestPrompt = QuestionPrompt | PermissionPrompt;

const promptsByMessage = new Map<string, GuestPrompt>();

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function button(text: string, action: string): InlineKeyboardButton {
  return { text, callback_data: `${GUEST_PROMPT_CALLBACK_PREFIX}${action}` };
}

function optionAnswer(question: Question, optionIndex: number): string | undefined {
  const option = question.options[optionIndex];
  return option ? (option.value ?? option.label) : undefined;
}

function renderQuestion(prompt: QuestionPrompt): { text: string; markup: InlineKeyboardMarkup } {
  const question = prompt.questions[prompt.index] as Question;
  const lines = [`❓ ${question.header || t("guest.question.title")}`];
  if (prompt.questions.length > 1) {
    lines[0] += ` (${prompt.index + 1}/${prompt.questions.length})`;
  }
  lines.push("", question.question);
  const described = question.options.filter((option) => option.description);
  if (described.length > 0) {
    lines.push("", ...described.map((option) => `• ${option.label} — ${option.description}`));
  }
  if (question.multiple) {
    lines.push(t("question.multi_hint"));
  }
  if (question.custom !== false) {
    lines.push("", t("guest.question.custom_hint"));
  }

  const rows = question.options.map((option, optionIndex) => {
    const mark = question.multiple ? (prompt.selected.has(optionIndex) ? "✅ " : "⬜ ") : "";
    return [button(`${mark}${truncate(option.label, OPTION_LABEL_CHARS)}`, `o:${optionIndex}`)];
  });
  if (question.multiple) {
    rows.push([button(t("question.button.submit"), "done")]);
  }
  rows.push([button(t("guest.question.dismiss"), "x")]);
  return { text: lines.join("\n"), markup: { inline_keyboard: rows } };
}

function renderPermission(prompt: PermissionPrompt): {
  text: string;
  markup: InlineKeyboardMarkup;
} {
  return {
    text: formatPermissionText(prompt.request),
    markup: {
      inline_keyboard: [
        [button(t("permission.button.allow"), "p:once")],
        [button(t("permission.button.always"), "p:always")],
        [button(t("permission.button.reject"), "p:reject")],
      ],
    },
  };
}

async function drawPrompt(api: Api, prompt: GuestPrompt): Promise<void> {
  const { text, markup } =
    prompt.kind === "question" ? renderQuestion(prompt) : renderPermission(prompt);
  await api.editMessageTextInline(prompt.inlineMessageId, text, { reply_markup: markup });
}

function toPrompt(
  inlineMessageId: string,
  session: GuestSessionRef,
  pending: PendingInteractiveRequest,
): GuestPrompt {
  const base = {
    inlineMessageId,
    sessionId: session.sessionId,
    directory: session.directory,
    requestId: pending.request.id,
    sending: false,
  };
  if (pending.kind === "question") {
    const questions = (pending.request.questions ?? []) as Question[];
    return {
      ...base,
      kind: "question",
      questions,
      index: 0,
      answers: questions.map(() => []),
      selected: new Set(),
    };
  }
  return {
    ...base,
    kind: "permission",
    request: {
      id: pending.request.id,
      sessionID: pending.request.sessionID,
      permission: pending.request.permission ?? "",
      patterns: pending.request.patterns ?? [],
      metadata: {},
      always: [],
    },
  };
}

/** Whether a question or permission is drawn on this message, so progress must not cover it. */
export function isGuestPromptShown(inlineMessageId: string): boolean {
  return promptsByMessage.has(inlineMessageId);
}

/** Draws what the session waits on over the turn's message, replacing its progress. */
export async function showGuestPrompt(
  api: Api,
  inlineMessageId: string,
  session: GuestSessionRef,
  pending: PendingInteractiveRequest,
): Promise<void> {
  const prompt = toPrompt(inlineMessageId, session, pending);
  if (prompt.kind === "question" && prompt.questions.length === 0) {
    logger.warn(`[GuestPrompt] Question without questions: requestId=${prompt.requestId}`);
    return;
  }
  promptsByMessage.set(inlineMessageId, prompt);
  logger.info(
    `[GuestPrompt] Showing ${prompt.kind}: sessionId=${prompt.sessionId}, requestId=${prompt.requestId}`,
  );
  await drawPrompt(api, prompt);
}

/** Forgets the prompt on this message; true when one was still waiting for an answer here. */
export function closeGuestPrompt(inlineMessageId: string): boolean {
  return promptsByMessage.delete(inlineMessageId);
}

async function submitAnswers(api: Api, prompt: QuestionPrompt): Promise<boolean> {
  prompt.sending = true;
  const sent = await answerGuestQuestion(prompt.directory, prompt.requestId, prompt.answers).catch(
    (error: unknown) => {
      logger.warn(`[GuestPrompt] Could not send answers: requestId=${prompt.requestId}`, error);
      return false;
    },
  );
  prompt.sending = false;
  if (!sent) {
    // Back to the last question, so the answer can be given again.
    prompt.index = prompt.questions.length - 1;
    prompt.answers[prompt.index] = [];
    prompt.selected.clear();
    await drawPrompt(api, prompt).catch(() => {});
    return false;
  }

  promptsByMessage.delete(prompt.inlineMessageId);
  const summary = truncate(
    prompt.answers.map((answer) => answer.join(", ")).join("; "),
    ANSWER_SUMMARY_CHARS,
  );
  await api
    .editMessageTextInline(
      prompt.inlineMessageId,
      t("guest.question.answered", { answer: summary }),
    )
    .catch((error: unknown) => logger.debug("[GuestPrompt] Could not show the answer", error));
  return true;
}

/** Records the current question's answer, then shows the next question or sends them all. */
async function answerCurrentQuestion(
  api: Api,
  prompt: QuestionPrompt,
  answer: string[],
): Promise<boolean> {
  prompt.answers[prompt.index] = answer;
  prompt.selected.clear();
  if (prompt.index < prompt.questions.length - 1) {
    prompt.index += 1;
    await drawPrompt(api, prompt).catch((error: unknown) =>
      logger.debug("[GuestPrompt] Could not show the next question", error),
    );
    return true;
  }
  return submitAnswers(api, prompt);
}

async function handleQuestionTap(
  ctx: Context,
  prompt: QuestionPrompt,
  action: string,
): Promise<void> {
  const question = prompt.questions[prompt.index] as Question;

  if (action === "x") {
    prompt.sending = true;
    const dismissed = await dismissGuestQuestion(prompt.directory, prompt.requestId).catch(
      () => false,
    );
    prompt.sending = false;
    if (!dismissed) {
      await ctx.answerCallbackQuery({ text: t("guest.prompt.failed") }).catch(() => {});
      return;
    }
    promptsByMessage.delete(prompt.inlineMessageId);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.api
      .editMessageTextInline(prompt.inlineMessageId, t("guest.question.dismissed"))
      .catch(() => {});
    return;
  }

  if (action === "done") {
    const answer = [...prompt.selected]
      .sort((left, right) => left - right)
      .map((optionIndex) => optionAnswer(question, optionIndex))
      .filter((value): value is string => value !== undefined);
    if (answer.length === 0) {
      await ctx
        .answerCallbackQuery({ text: t("question.select_one_required_callback") })
        .catch(() => {});
      return;
    }
    const accepted = await answerCurrentQuestion(ctx.api, prompt, answer);
    await ctx
      .answerCallbackQuery(accepted ? undefined : { text: t("guest.prompt.failed") })
      .catch(() => {});
    return;
  }

  const optionIndex = Number(action.slice("o:".length));
  const value = action.startsWith("o:") ? optionAnswer(question, optionIndex) : undefined;
  if (value === undefined) {
    await ctx.answerCallbackQuery({ text: t("guest.prompt.expired") }).catch(() => {});
    return;
  }

  if (question.multiple) {
    if (!prompt.selected.delete(optionIndex)) {
      prompt.selected.add(optionIndex);
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await drawPrompt(ctx.api, prompt).catch(() => {});
    return;
  }

  const accepted = await answerCurrentQuestion(ctx.api, prompt, [value]);
  await ctx
    .answerCallbackQuery(accepted ? undefined : { text: t("guest.prompt.failed") })
    .catch(() => {});
}

async function handlePermissionTap(
  ctx: Context,
  prompt: PermissionPrompt,
  action: string,
): Promise<void> {
  const reply = PERMISSION_REPLIES.find((candidate) => action === `p:${candidate}`);
  if (!reply) {
    await ctx.answerCallbackQuery({ text: t("guest.prompt.expired") }).catch(() => {});
    return;
  }

  prompt.sending = true;
  const sent = await replyGuestPermission(prompt.directory, prompt.requestId, reply).catch(
    () => false,
  );
  prompt.sending = false;
  if (!sent) {
    await ctx.answerCallbackQuery({ text: t("guest.prompt.failed") }).catch(() => {});
    return;
  }

  promptsByMessage.delete(prompt.inlineMessageId);
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.api
    .editMessageTextInline(
      prompt.inlineMessageId,
      formatPermissionText(prompt.request, 1, t(`permission.reply.${reply}`)),
    )
    .catch(() => {});
}

/**
 * A tap on a question or permission drawn on a guest message. Only the owner gets here: the auth
 * middleware answers anyone else's tap itself.
 */
export async function handleGuestPromptCallback(ctx: Context): Promise<void> {
  const inlineMessageId = ctx.callbackQuery?.inline_message_id;
  const action = (ctx.callbackQuery?.data ?? "").slice(GUEST_PROMPT_CALLBACK_PREFIX.length);
  const prompt = inlineMessageId ? promptsByMessage.get(inlineMessageId) : undefined;
  if (!prompt) {
    await ctx.answerCallbackQuery({ text: t("guest.prompt.expired") }).catch(() => {});
    return;
  }
  if (prompt.sending) {
    await ctx.answerCallbackQuery({ text: t("question.answer_already_received") }).catch(() => {});
    return;
  }

  if (prompt.kind === "question") {
    await handleQuestionTap(ctx, prompt, action);
  } else {
    await handlePermissionTap(ctx, prompt, action);
  }
}

/**
 * A typed answer: a guest message replying into a conversation whose question takes one. Returns
 * the note to answer the message with, or null when no question there takes a typed answer.
 */
export async function answerGuestQuestionWithText(
  api: Api,
  sessionId: string,
  text: string,
): Promise<string | null> {
  const prompt = [...promptsByMessage.values()].find(
    (candidate): candidate is QuestionPrompt =>
      candidate.kind === "question" && candidate.sessionId === sessionId && !candidate.sending,
  );
  if (!prompt || prompt.questions[prompt.index]?.custom === false) {
    return null;
  }

  const accepted = await answerCurrentQuestion(api, prompt, [text]);
  return accepted
    ? t("guest.question.answer_received", { answer: truncate(text, ANSWER_SUMMARY_CHARS) })
    : t("guest.prompt.failed");
}

export function __resetGuestPromptsForTests(): void {
  promptsByMessage.clear();
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import {
  closeQuestionSettledOutside,
  showCurrentQuestion,
} from "../../../src/bot/menus/question-menu.js";
import {
  handleQuestionCallback,
  handleQuestionTextAnswer,
} from "../../../src/bot/callbacks/question-callback-handler.js";
import type { Question } from "../../../src/app/types/question.js";
import { t } from "../../../src/i18n/index.js";
import { defined } from "../../helpers/defined.js";
import { createTestAppContainer } from "../../helpers/app-container.js";
import type { AppContainer } from "../../../src/app/bootstrap/app-container.js";

const mocked = vi.hoisted(() => ({
  questionReplyMock: vi.fn(),
  questionRejectMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    question: {
      reply: mocked.questionReplyMock,
      reject: mocked.questionRejectMock,
    },
  },
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: vi.fn(() => ({ id: "project-1", worktree: "D:/repo" })),
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: vi.fn(() => null),
}));

const QUESTION_ONE: Question = {
  header: "Q1",
  question: "Pick one",
  options: [
    { label: "Yes", description: "accept" },
    { label: "No", description: "decline" },
  ],
};

const QUESTION_TWO: Question = {
  header: "Q2",
  question: "Second question",
  options: [
    { label: "Alpha", description: "first" },
    { label: "Beta", description: "second" },
  ],
};

const MULTIPLE_QUESTION: Question = {
  header: "Q multi",
  question: "Pick multiple",
  multiple: true,
  options: [
    { label: "One", description: "1" },
    { label: "Two", description: "2" },
  ],
};

function createApi(sendMessageIds: number[]): Context["api"] {
  let index = 0;

  const nextMessage = async () => {
    const messageId = sendMessageIds[index] ?? sendMessageIds[sendMessageIds.length - 1] ?? 1;
    index += 1;
    return { message_id: messageId };
  };

  return {
    sendMessage: vi.fn().mockImplementation(nextMessage),
    sendRichMessage: vi.fn().mockImplementation(nextMessage),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  } as unknown as Context["api"];
}

function createCallbackContext(data: string, messageId: number, api: Context["api"]): Context {
  return {
    chat: { id: 123 },
    callbackQuery: {
      data,
      message: {
        message_id: messageId,
      },
    } as Context["callbackQuery"],
    api,
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function createTextContext(text: string, api: Context["api"]): Context {
  return {
    chat: { id: 123 },
    message: {
      text,
    } as Context["message"],
    api,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

async function pressButton(data: string, messageId: number, api: Context["api"]): Promise<void> {
  await handleQuestionCallback(createCallbackContext(data, messageId, api), createDeps());
}

function createDeps() {
  return container;
}

let container: AppContainer;

beforeEach(() => {
  container = createTestAppContainer();
});

describe("bot question menu/callbacks", () => {
  beforeEach(() => {
    container.questionManager.clear();
    container.interactionManager.clear("test_setup");
    mocked.questionReplyMock.mockReset();
    mocked.questionReplyMock.mockResolvedValue({ data: true, error: undefined });
    mocked.questionRejectMock.mockReset();
    mocked.questionRejectMock.mockResolvedValue({ data: true, error: undefined });
  });

  it("shows question details and keyboard in one message", async () => {
    const api = createApi([100]);

    container.questionManager.startQuestions([QUESTION_ONE], "req-1", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    expect(api.sendRichMessage).toHaveBeenNthCalledWith(
      1,
      123,
      {
        blocks: [
          { type: "paragraph", text: { type: "bold", text: "❓ 1/1 Q1" } },
          { type: "paragraph", text: "Pick one" },
          { type: "paragraph", text: [{ type: "bold", text: "Yes" }, " — accept"] },
          { type: "paragraph", text: [{ type: "bold", text: "No" }, " — decline"] },
        ],
      },
      {
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            [{ text: "Yes", callback_data: "question:select:0:0" }],
            [{ text: "No", callback_data: "question:select:0:1" }],
          ]),
        }),
      },
    );
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(container.questionManager.getMessageIds()).toEqual([100]);
    expect(container.questionManager.getActiveMessageId()).toBe(100);

    const state = container.interactionManager.getSnapshot();
    expect(state?.kind).toBe("question");
    expect(state?.expectedInput).toBe("callback");
    expect(state?.metadata.requestID).toBe("req-1");
    expect(state?.metadata.messageId).toBe(100);
    expect(state?.metadata.questionIndex).toBe(0);
  });

  it("falls back to raw question text when the native send fails", async () => {
    const sendMessage = vi.fn().mockResolvedValueOnce({ message_id: 801 });
    const sendRichMessage = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Bad Request: RICH_MESSAGE_BLOCK_UNSUPPORTED"), { error_code: 400 }),
      );
    const api = {
      sendMessage,
      sendRichMessage,
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    } as unknown as Context["api"];

    container.questionManager.startQuestions([QUESTION_ONE], "req-fallback", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      123,
      expect.stringContaining("❓ 1/1 Q1\n\nPick one\n\nYes — accept\n\nNo — decline"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(container.questionManager.getActiveMessageId()).toBe(801);
  });

  it("renders an option without a description as a bold label only", async () => {
    const api = createApi([902]);
    const question: Question = {
      header: "Bare",
      question: "Choose",
      options: [{ label: "Only label", description: "" }],
    };

    container.questionManager.startQuestions([question], "req-bare", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    const calls = (api.sendRichMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const message = defined(calls[0]?.[1]) as { blocks: unknown[] };

    expect(message.blocks.at(-1)).toEqual({
      type: "paragraph",
      text: { type: "bold", text: "Only label" },
    });
  });

  it("truncates long question text to Telegram message limit", async () => {
    const api = createApi([901]);
    const longQuestion: Question = {
      header: "Long",
      question: "Q".repeat(5000),
      options: [{ label: "Option", description: "description" }],
    };

    container.questionManager.startQuestions([longQuestion], "req-long", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    const calls = (api.sendRichMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const message = defined(calls[0]?.[1]) as { blocks: Array<{ text: unknown }> };

    const flatten = (text: unknown): string => {
      if (typeof text === "string") {
        return text;
      }
      if (Array.isArray(text)) {
        return text.map(flatten).join("");
      }
      if (text && typeof text === "object" && "text" in text) {
        return flatten((text as { text: unknown }).text);
      }
      return "";
    };

    const rendered = message.blocks.map((block) => flatten(block.text));
    expect(rendered.join("\n\n").length).toBeLessThanOrEqual(4096);
    expect(rendered.at(-1)?.endsWith("…")).toBe(true);
  });

  it("switches to mixed mode on custom callback and accepts custom text", async () => {
    const api = createApi([101, 102]);

    container.questionManager.startQuestions([QUESTION_ONE, QUESTION_TWO], "req-2", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    const customCtx = createCallbackContext("question:custom:0", 101, api);
    await handleQuestionCallback(customCtx, createDeps());

    expect(container.questionManager.isWaitingForCustomInput(0)).toBe(true);
    expect(container.interactionManager.getSnapshot()?.expectedInput).toBe("mixed");

    const textCtx = createTextContext("My custom answer", api);
    await handleQuestionTextAnswer(textCtx, createDeps());

    expect(container.questionManager.getCustomAnswer(0)).toBe("My custom answer");
    expect(container.questionManager.getCurrentIndex()).toBe(1);
    expect(container.questionManager.getActiveMessageId()).toBe(102);
    expect(container.interactionManager.getSnapshot()?.expectedInput).toBe("callback");

    expect(api.deleteMessage).toHaveBeenCalledWith(123, 101);
  });

  it("deletes the question message after single-choice selection", async () => {
    const api = createApi([701, 702]);

    container.questionManager.startQuestions([QUESTION_ONE, QUESTION_TWO], "req-8", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    const selectCtx = createCallbackContext("question:select:0:0", 701, api);
    const handled = await handleQuestionCallback(selectCtx, createDeps());

    expect(handled).toBe(true);
    expect(selectCtx.deleteMessage).toHaveBeenCalledOnce();
    expect(container.questionManager.getCurrentIndex()).toBe(1);
    expect(container.questionManager.getActiveMessageId()).toBe(702);
  });

  it("rejects stale callback from old question message", async () => {
    const api = createApi([200]);

    container.questionManager.startQuestions([QUESTION_ONE], "req-3", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    const staleCtx = createCallbackContext("question:select:0:0", 199, api);
    const handled = await handleQuestionCallback(staleCtx, createDeps());

    expect(handled).toBe(true);
    expect(staleCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("question.inactive_callback"),
      show_alert: true,
    });
    expect(container.questionManager.getSelectedOptions(0)).toEqual(new Set<number>());
  });

  it("answers the callback when the current question is already gone", async () => {
    const api = createApi([250]);

    container.questionManager.startQuestions([QUESTION_ONE], "req-stale", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    // Index past the last question: the message is still active, but there is
    // nothing to answer anymore.
    container.questionManager.nextQuestion();

    const ctx = createCallbackContext("question:select:0:0", 250, api);
    const handled = await handleQuestionCallback(ctx, createDeps());

    expect(handled).toBe(true);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("question.inactive_callback"),
      show_alert: true,
    });
  });

  it("dismisses the question in OpenCode on Cancel and then closes the poll", async () => {
    const api = createApi([300]);

    container.questionManager.startQuestions([QUESTION_ONE], "req-4", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    const cancelCtx = createCallbackContext("question:cancel:0", 300, api);
    const handled = await handleQuestionCallback(cancelCtx, createDeps());

    expect(handled).toBe(true);
    expect(cancelCtx.answerCallbackQuery).toHaveBeenCalledWith({ text: t("common.cancelled") });
    expect(mocked.questionRejectMock).toHaveBeenCalledWith({
      requestID: "req-4",
      directory: "D:/repo",
    });
    await vi.waitFor(() => {
      expect(api.editMessageText).toHaveBeenCalledWith(123, 300, t("question.cancelled"));
    });
    expect(cancelCtx.editMessageText).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(container.questionManager.isActive()).toBe(false);
    expect(container.interactionManager.getSnapshot()).toBeNull();
  });

  it("keeps the poll open and ignores its buttons while the dismissal is on its way", async () => {
    const api = createApi([301]);
    let resolveReject: (value: { data: boolean; error: undefined }) => void = () => {};
    mocked.questionRejectMock.mockReturnValue(
      new Promise((resolve) => {
        resolveReject = resolve;
      }),
    );

    container.questionManager.startQuestions([QUESTION_ONE], "req-wait", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:custom:0", 301, api);
    await pressButton("question:cancel:0", 301, api);

    expect(container.questionManager.isActive()).toBe(true);
    expect(container.questionManager.isWaitingForCustomInput(0)).toBe(false);
    expect(api.editMessageText).not.toHaveBeenCalled();

    const selectCtx = createCallbackContext("question:select:0:0", 301, api);
    await handleQuestionCallback(selectCtx, createDeps());
    await pressButton("question:cancel:0", 301, api);

    expect(selectCtx.answerCallbackQuery).toHaveBeenCalledWith();
    expect(mocked.questionReplyMock).not.toHaveBeenCalled();
    expect(mocked.questionRejectMock).toHaveBeenCalledTimes(1);

    const textCtx = createTextContext("my custom", api);
    await handleQuestionTextAnswer(textCtx, createDeps());
    expect(textCtx.reply).toHaveBeenCalledWith(t("question.use_custom_button_first"));

    resolveReject({ data: true, error: undefined });
    await vi.waitFor(() => {
      expect(container.questionManager.isActive()).toBe(false);
    });
  });

  it("leaves the poll answerable with a warning when the dismissal fails", async () => {
    const api = createApi([302, 303]);
    mocked.questionRejectMock.mockResolvedValueOnce({
      data: undefined,
      error: new Error("fetch failed"),
    });

    container.questionManager.startQuestions([QUESTION_ONE], "req-fail", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:cancel:0", 302, api);

    const editMock = api.editMessageText as unknown as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      expect(editMock).toHaveBeenCalled();
    });
    const [, messageId, content, options] = defined(editMock.mock.calls[0]);
    expect(messageId).toBe(302);
    expect(JSON.stringify(content)).toContain(t("permission.delivery_failed"));
    expect(JSON.stringify(content)).toContain(QUESTION_ONE.question);
    expect(options).toHaveProperty("reply_markup");
    expect(container.questionManager.isActive()).toBe(true);
    expect(container.questionManager.isDismissing()).toBe(false);
    expect(container.questionManager.hasLastCancelFailed()).toBe(true);

    await pressButton("question:cancel:0", 302, api);

    expect(mocked.questionRejectMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(api.editMessageText).toHaveBeenCalledWith(123, 302, t("question.cancelled"));
    });
    expect(container.questionManager.isActive()).toBe(false);
  });

  it("warns instead of closing the poll when there is no request to dismiss", async () => {
    const api = createApi([310]);

    container.questionManager.startQuestions([QUESTION_ONE], "", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:cancel:0", 310, api);

    expect(mocked.questionRejectMock).not.toHaveBeenCalled();
    const editMock = api.editMessageText as unknown as ReturnType<typeof vi.fn>;
    const [, messageId, content, options] = defined(editMock.mock.calls[0]);
    expect(messageId).toBe(310);
    expect(JSON.stringify(content)).toContain(t("permission.delivery_failed"));
    expect(options).toHaveProperty("reply_markup");
    expect(container.questionManager.isActive()).toBe(true);
  });

  it("answers normally when a choice is tapped after a failed dismissal", async () => {
    const api = createApi([304, 305]);
    mocked.questionRejectMock.mockResolvedValueOnce({ data: undefined, error: { name: "Boom" } });

    container.questionManager.startQuestions([QUESTION_ONE], "req-choice", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:cancel:0", 304, api);
    await vi.waitFor(() => {
      expect(container.questionManager.hasLastCancelFailed()).toBe(true);
    });

    await pressButton("question:select:0:1", 304, api);

    expect(mocked.questionReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestID: "req-choice" }),
    );
    expect(container.questionManager.isActive()).toBe(false);
  });

  it.each([
    [{ name: "NotFoundError", data: { message: "gone" } }],
    [{ _tag: "QuestionNotFoundError", requestID: "req-gone", message: "gone" }],
  ])("closes the poll as cancelled outside when OpenCode no longer has it", async (error) => {
    const api = createApi([306]);
    mocked.questionRejectMock.mockResolvedValueOnce({ data: undefined, error });

    container.questionManager.startQuestions([QUESTION_ONE], "req-gone", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:cancel:0", 306, api);

    const editMock = api.editMessageText as unknown as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      expect(editMock).toHaveBeenCalled();
    });
    const [, , content, options] = defined(editMock.mock.calls[0]);
    expect(JSON.stringify(content)).toContain(t("question.settled_outside.cancelled"));
    expect(options ?? {}).not.toHaveProperty("reply_markup");
    expect(container.questionManager.isActive()).toBe(false);
  });

  it("closes the poll as answered outside when OpenCode reported an answer meanwhile", async () => {
    const api = createApi([307]);
    mocked.questionRejectMock.mockImplementationOnce(async () => {
      container.questionManager.noteSettledWhileSending("answered");
      return { data: undefined, error: { name: "NotFoundError" } };
    });

    container.questionManager.startQuestions([QUESTION_ONE], "req-answered", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:cancel:0", 307, api);

    const editMock = api.editMessageText as unknown as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      expect(editMock).toHaveBeenCalled();
    });
    expect(JSON.stringify(defined(editMock.mock.calls[0])[2])).toContain(
      t("question.settled_outside.answered"),
    );
  });

  it("closes the poll as cancelled when the reply was lost but OpenCode reported the dismissal", async () => {
    const api = createApi([308]);
    mocked.questionRejectMock.mockImplementationOnce(async () => {
      container.questionManager.noteSettledWhileSending("cancelled");
      throw new Error("socket hang up");
    });

    container.questionManager.startQuestions([QUESTION_ONE], "req-lost", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:cancel:0", 308, api);

    await vi.waitFor(() => {
      expect(api.editMessageText).toHaveBeenCalledWith(123, 308, t("question.cancelled"));
    });
    expect(container.questionManager.isActive()).toBe(false);
  });

  it("changes nothing when the poll was ended before the dismissal came back", async () => {
    const api = createApi([309]);
    let resolveReject: (value: { data: boolean; error: undefined }) => void = () => {};
    mocked.questionRejectMock.mockReturnValue(
      new Promise((resolve) => {
        resolveReject = resolve;
      }),
    );

    container.questionManager.startQuestions([QUESTION_ONE], "req-reset", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:cancel:0", 309, api);

    container.interactionManager.reset("abort_command");
    resolveReject({ data: true, error: undefined });
    await new Promise((resolve) => setImmediate(resolve));

    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("requires at least one selected option on multiple submit", async () => {
    const api = createApi([400]);

    container.questionManager.startQuestions([MULTIPLE_QUESTION], "req-5", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    const submitCtx = createCallbackContext("question:submit:0", 400, api);
    const handled = await handleQuestionCallback(submitCtx, createDeps());

    expect(handled).toBe(true);
    expect(submitCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("question.select_one_required_callback"),
      show_alert: true,
    });
    expect(container.questionManager.isActive()).toBe(true);
  });

  it("updates question message on multiple selection with compact button label", async () => {
    const api = createApi([500]);

    container.questionManager.startQuestions([MULTIPLE_QUESTION], "req-6", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    const selectCtx = createCallbackContext("question:select:0:0", 500, api);
    const handled = await handleQuestionCallback(selectCtx, createDeps());

    expect(handled).toBe(true);
    expect(api.editMessageText).toHaveBeenCalledWith(
      123,
      500,
      {
        blocks: [
          { type: "paragraph", text: { type: "bold", text: "❓ 1/1 Q multi" } },
          { type: "paragraph", text: `Pick multiple${t("question.multi_hint")}` },
          { type: "paragraph", text: [{ type: "bold", text: "One" }, " — 1"] },
          { type: "paragraph", text: [{ type: "bold", text: "Two" }, " — 2"] },
        ],
      },
      {
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            [{ text: "✅ One", callback_data: "question:select:0:0" }],
            [{ text: "Two", callback_data: "question:select:0:1" }],
          ]),
        }),
      },
    );
  });

  it("keeps requiring custom button before accepting text answer", async () => {
    const api = createApi([600]);

    container.questionManager.startQuestions([QUESTION_ONE], "req-7", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    const textCtx = createTextContext("Typed without custom button", api);
    await handleQuestionTextAnswer(textCtx, createDeps());

    expect(textCtx.reply).toHaveBeenCalledWith(t("question.use_custom_button_first"));
    expect(container.questionManager.getCurrentIndex()).toBe(0);
  });

  it("keeps a multi-select question open after custom text and re-sends it with the custom row", async () => {
    const api = createApi([800, 801]);

    container.questionManager.startQuestions([MULTIPLE_QUESTION], "req-multi-custom", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    await pressButton("question:select:0:1", 800, api);
    await pressButton("question:custom:0", 800, api);
    await handleQuestionTextAnswer(createTextContext("My\nown answer", api), createDeps());

    expect(api.deleteMessage).toHaveBeenCalledWith(123, 800);
    expect(container.questionManager.getCurrentIndex()).toBe(0);
    expect(container.questionManager.getActiveMessageId()).toBe(801);
    expect(container.interactionManager.getSnapshot()?.expectedInput).toBe("callback");
    expect(api.sendRichMessage).toHaveBeenLastCalledWith(123, expect.anything(), {
      reply_markup: expect.objectContaining({
        inline_keyboard: [
          [{ text: "One", callback_data: "question:select:0:0" }],
          [{ text: "✅ Two", callback_data: "question:select:0:1" }],
          [{ text: "✅ ✏️ My own answer", callback_data: "question:toggle_custom:0" }],
          [{ text: t("question.button.submit"), callback_data: "question:submit:0" }],
          [{ text: t("question.button.custom"), callback_data: "question:custom:0" }],
          [{ text: t("question.button.cancel"), callback_data: "question:cancel:0" }],
        ],
      }),
    });
  });

  it("replaces the custom text when a new one is sent to a multi-select question", async () => {
    const api = createApi([810, 811, 812]);

    container.questionManager.startQuestions([MULTIPLE_QUESTION], "req-multi-replace", "session-1");
    await showCurrentQuestion(api, 123, createDeps());

    await pressButton("question:custom:0", 810, api);
    await handleQuestionTextAnswer(createTextContext("First", api), createDeps());
    await pressButton("question:toggle_custom:0", 811, api);
    await pressButton("question:custom:0", 811, api);
    const textCtx = createTextContext("Second", api);
    await handleQuestionTextAnswer(textCtx, createDeps());

    expect(textCtx.reply).not.toHaveBeenCalled();
    expect(container.questionManager.getCustomAnswer(0)).toBe("Second");
    expect(container.questionManager.isCustomAnswerSelected(0)).toBe(true);
    expect(container.questionManager.getActiveMessageId()).toBe(812);
  });

  it("toggles the custom row in place", async () => {
    const api = createApi([820, 821]);

    container.questionManager.startQuestions([MULTIPLE_QUESTION], "req-multi-toggle", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:custom:0", 820, api);
    await handleQuestionTextAnswer(createTextContext("Mine", api), createDeps());

    const toggleCtx = createCallbackContext("question:toggle_custom:0", 821, api);
    await handleQuestionCallback(toggleCtx, createDeps());

    expect(container.questionManager.isCustomAnswerSelected(0)).toBe(false);
    expect(toggleCtx.answerCallbackQuery).toHaveBeenCalledWith();
    expect(api.editMessageText).toHaveBeenLastCalledWith(123, 821, expect.anything(), {
      reply_markup: expect.objectContaining({
        inline_keyboard: expect.arrayContaining([
          [{ text: "✏️ Mine", callback_data: "question:toggle_custom:0" }],
        ]),
      }),
    });

    const submitCtx = createCallbackContext("question:submit:0", 821, api);
    await handleQuestionCallback(submitCtx, createDeps());

    expect(submitCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("question.select_one_required_callback"),
      show_alert: true,
    });
    expect(container.questionManager.isActive()).toBe(true);
  });

  it("sends the ticked options and the ticked custom text on submit", async () => {
    const api = createApi([830, 831, 832]);

    container.questionManager.startQuestions([MULTIPLE_QUESTION], "req-multi-submit", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:custom:0", 830, api);
    await handleQuestionTextAnswer(createTextContext("Line one\nline two", api), createDeps());
    await pressButton("question:select:0:0", 831, api);
    await pressButton("question:submit:0", 831, api);

    expect(mocked.questionReplyMock).toHaveBeenCalledWith({
      requestID: "req-multi-submit",
      directory: "D:/repo",
      answers: [["* One: 1", "Line one\nline two"]],
    });
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      123,
      expect.stringContaining(
        t("question.summary.answer", { answer: "* One: 1\nLine one\nline two" }),
      ),
    );
    expect(container.questionManager.isActive()).toBe(false);
  });

  it("marks the poll as answered from Telegram before its answers go out", async () => {
    const api = createApi([850, 851]);
    const markedAtReply: boolean[] = [];
    mocked.questionReplyMock.mockImplementation(async () => {
      markedAtReply.push(container.questionManager.isAnswering());
      return { data: true, error: undefined };
    });

    container.questionManager.startQuestions([QUESTION_ONE], "req-mark", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:select:0:0", 850, api);

    expect(markedAtReply).toEqual([true]);
    expect(container.questionManager.isActive()).toBe(false);
  });

  it("closes a poll settled outside Telegram with its line and no buttons", async () => {
    const api = createApi([860]);

    container.questionManager.startQuestions([QUESTION_ONE], "req-outside", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await closeQuestionSettledOutside(api, 123, "cancelled", createDeps());

    const editMock = api.editMessageText as unknown as ReturnType<typeof vi.fn>;
    const [chatId, messageId, content, options] = defined(editMock.mock.calls[0]);
    expect(chatId).toBe(123);
    expect(messageId).toBe(860);
    expect(JSON.stringify(content)).toContain(t("question.settled_outside.cancelled"));
    expect(JSON.stringify(content)).toContain(QUESTION_ONE.question);
    expect(options ?? {}).not.toHaveProperty("reply_markup");
    expect(container.questionManager.isActive()).toBe(false);
    expect(container.interactionManager.getSnapshot()).toBeNull();
  });

  it("submits a multi-select question whose only ticked item is the custom text", async () => {
    const api = createApi([840, 841]);

    container.questionManager.startQuestions([MULTIPLE_QUESTION], "req-multi-only-custom", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:custom:0", 840, api);
    await handleQuestionTextAnswer(createTextContext("Only mine", api), createDeps());
    await pressButton("question:submit:0", 841, api);

    expect(mocked.questionReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ answers: [["Only mine"]] }),
    );
  });

  it("offers the custom answer button only when the question accepts one", async () => {
    const keyboardRows = async (question: Question): Promise<string[]> => {
      const api = createApi([900]);
      container.questionManager.startQuestions([question], "req-custom-flag", "session-1");
      await showCurrentQuestion(api, 123, createDeps());
      const options = vi.mocked(api.sendRichMessage).mock.calls[0]?.[2] as {
        reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
      };
      return options.reply_markup.inline_keyboard.map((row) => defined(row[0]).callback_data);
    };

    expect(await keyboardRows({ ...QUESTION_ONE, custom: false })).toEqual([
      "question:select:0:0",
      "question:select:0:1",
      "question:cancel:0",
    ]);
    expect(await keyboardRows({ ...MULTIPLE_QUESTION, custom: false })).toEqual([
      "question:select:0:0",
      "question:select:0:1",
      "question:submit:0",
      "question:cancel:0",
    ]);
    expect(await keyboardRows(QUESTION_ONE)).toContain("question:custom:0");
    expect(await keyboardRows({ ...QUESTION_ONE, custom: true })).toContain("question:custom:0");
    expect(
      await keyboardRows({ header: "Free", question: "Type it", options: [], custom: false }),
    ).toEqual(["question:custom:0", "question:cancel:0"]);
  });

  it("sends the tapped choice's value and shows its label in the summary", async () => {
    const api = createApi([910, 911]);
    const searchQuestion: Question = {
      header: "Web search",
      question: "Allow OpenCode to search the web?",
      custom: false,
      options: [
        { label: "Allow search via Exa", description: "", value: "allow" },
        { label: "Disable web search", description: "", value: "disable" },
      ],
    };

    container.questionManager.startQuestions([searchQuestion, QUESTION_ONE], "req-values", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:select:0:0", 910, api);
    await pressButton("question:select:1:1", 911, api);

    expect(mocked.questionReplyMock).toHaveBeenCalledWith({
      requestID: "req-values",
      directory: "D:/repo",
      answers: [["allow"], ["* No: decline"]],
    });
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      123,
      expect.stringContaining(t("question.summary.answer", { answer: "* Allow search via Exa: " })),
    );
  });
});

describe("poll answers delivered to OpenCode", () => {
  beforeEach(() => {
    mocked.questionReplyMock.mockReset();
    mocked.questionReplyMock.mockResolvedValue({ data: true, error: undefined });
    mocked.questionRejectMock.mockReset();
    mocked.questionRejectMock.mockResolvedValue({ data: true, error: undefined });
  });

  function editsOf(api: Context["api"], messageId: number): string[] {
    const editMock = api.editMessageText as unknown as ReturnType<typeof vi.fn>;
    return editMock.mock.calls
      .filter((call) => call[1] === messageId)
      .map((call) => JSON.stringify(call[2]));
  }

  it("keeps the last question on screen until OpenCode takes the answers", async () => {
    const api = createApi([900, 901]);
    let resolveReply: (value: { data: boolean; error: undefined }) => void = () => {};
    mocked.questionReplyMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReply = resolve;
      }),
    );

    container.questionManager.startQuestions([QUESTION_ONE], "req-wait", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:select:0:0", 900, api);

    expect(api.deleteMessage).not.toHaveBeenCalledWith(123, 900);
    expect(container.questionManager.isAnswering()).toBe(true);

    // Buttons do nothing while the answers are on their way.
    await pressButton("question:select:0:1", 900, api);
    expect(mocked.questionReplyMock).toHaveBeenCalledTimes(1);

    resolveReply({ data: true, error: undefined });
    await vi.waitFor(() => {
      expect(container.questionManager.isActive()).toBe(false);
    });
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 900);
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      123,
      expect.stringContaining(t("question.summary.title")),
    );
  });

  it("leaves the poll answerable with a warning when the answers fail, and a retap resends", async () => {
    const api = createApi([910, 911]);
    mocked.questionReplyMock.mockResolvedValueOnce({
      data: undefined,
      error: { _tag: "FormInvalidAnswerError", message: "invalid" },
    });

    container.questionManager.startQuestions([QUESTION_ONE, QUESTION_TWO], "req-fail", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:select:0:0", 910, api);
    await pressButton("question:select:1:0", 911, api);

    await vi.waitFor(() => {
      expect(editsOf(api, 911).join()).toContain(t("permission.delivery_failed"));
    });
    const editMock = api.editMessageText as unknown as ReturnType<typeof vi.fn>;
    expect(defined(editMock.mock.calls.at(-1))[3]).toHaveProperty("reply_markup");
    expect(container.questionManager.isActive()).toBe(true);
    expect(container.questionManager.getCurrentIndex()).toBe(1);
    expect(api.deleteMessage).not.toHaveBeenCalledWith(123, 911);

    await pressButton("question:select:1:1", 911, api);

    await vi.waitFor(() => {
      expect(container.questionManager.isActive()).toBe(false);
    });
    expect(mocked.questionReplyMock).toHaveBeenCalledTimes(2);
    expect(mocked.questionReplyMock.mock.calls[1]?.[0]).toMatchObject({
      requestID: "req-fail",
      answers: [["* Yes: accept"], ["* Beta: second"]],
    });
  });

  it.each([
    [{ name: "NotFoundError", data: { message: "gone" } }],
    [{ _tag: "FormAlreadySettledError", message: "Form already settled" }],
  ])("closes the poll as answered outside when OpenCode already settled it", async (error) => {
    const api = createApi([920]);
    mocked.questionReplyMock.mockResolvedValueOnce({ data: undefined, error });

    container.questionManager.startQuestions([QUESTION_ONE], "req-gone", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:select:0:0", 920, api);

    await vi.waitFor(() => {
      expect(container.questionManager.isActive()).toBe(false);
    });
    expect(editsOf(api, 920).join()).toContain(t("question.settled_outside.answered"));
    expect(editsOf(api, 920).join()).not.toContain(t("permission.delivery_failed"));
  });

  it("closes the poll as cancelled outside when OpenCode reported a cancel meanwhile", async () => {
    const api = createApi([925]);
    mocked.questionReplyMock.mockImplementationOnce(async () => {
      container.questionManager.noteSettledWhileSending("cancelled");
      return { data: undefined, error: { _tag: "FormAlreadySettledError", message: "settled" } };
    });

    container.questionManager.startQuestions([QUESTION_ONE], "req-cancelled", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:select:0:0", 925, api);

    await vi.waitFor(() => {
      expect(container.questionManager.isActive()).toBe(false);
    });
    expect(editsOf(api, 925).join()).toContain(t("question.settled_outside.cancelled"));
  });

  it("drops a failed custom answer so it is typed again after a new Custom answer tap", async () => {
    const api = createApi([930]);
    mocked.questionReplyMock.mockResolvedValueOnce({
      data: undefined,
      error: new Error("fetch failed"),
    });

    container.questionManager.startQuestions([QUESTION_ONE], "req-custom", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:custom:0", 930, api);
    await handleQuestionTextAnswer(createTextContext("my own", api), createDeps());

    await vi.waitFor(() => {
      expect(editsOf(api, 930).join()).toContain(t("permission.delivery_failed"));
    });
    expect(container.questionManager.hasCustomAnswer(0)).toBe(false);

    const strayText = createTextContext("again", api);
    await handleQuestionTextAnswer(strayText, createDeps());
    expect(strayText.reply).toHaveBeenCalledWith(t("question.use_custom_button_first"));

    await pressButton("question:custom:0", 930, api);
    await handleQuestionTextAnswer(createTextContext("my own again", api), createDeps());

    await vi.waitFor(() => {
      expect(container.questionManager.isActive()).toBe(false);
    });
    expect(mocked.questionReplyMock.mock.calls[1]?.[0]).toMatchObject({
      answers: [["my own again"]],
    });
  });

  it("leaves a poll ended by a reset while its answers were on their way as it is", async () => {
    const api = createApi([940]);
    mocked.questionReplyMock.mockImplementationOnce(async () => {
      container.interactionManager.reset("abort_command");
      return { data: undefined, error: new Error("fetch failed") };
    });

    container.questionManager.startQuestions([QUESTION_ONE], "req-reset", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:select:0:0", 940, api);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(container.questionManager.isActive()).toBe(false);
    expect(editsOf(api, 940).join()).not.toContain(t("permission.delivery_failed"));
  });

  it("ends a restored poll whose run ended while its message was on the way, and frees the slot", async () => {
    const api = createApi([960]);
    let land: () => void = () => {};
    const held = () =>
      new Promise((resolve) => {
        land = () => resolve({ message_id: 960 });
      });
    (api.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(held);
    (api.sendRichMessage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(held);

    // As the attach restore does: open the slot, then send the poll.
    container.questionManager.startQuestions([QUESTION_ONE], "req-restored", "session-1");
    const shown = showCurrentQuestion(api, 123, createDeps());
    container.questionManager.endInFlightForSession("session-1", "not_answered");
    land();
    await shown;

    expect(editsOf(api, 960).join()).toContain(t("question.not_answered"));
    expect(container.interactionManager.getSnapshot()).toBeNull();
  });

  it("leaves a poll settled outside Telegram while its tap was acknowledged with its line", async () => {
    const api = createApi([970]);

    container.questionManager.startQuestions([QUESTION_ONE], "req-race", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    const ctx = createCallbackContext("question:select:0:0", 970, api);
    (ctx.answerCallbackQuery as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        await closeQuestionSettledOutside(api, 123, "cancelled", createDeps());
      },
    );

    await handleQuestionCallback(ctx, createDeps());

    expect(ctx.deleteMessage).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalledWith(123, 970);
    expect(mocked.questionReplyMock).not.toHaveBeenCalled();
    expect(editsOf(api, 970).join()).toContain(t("question.settled_outside.cancelled"));
  });

  it("closes the poll as cancelled outside when Cancel hits an already settled V2 form", async () => {
    const api = createApi([950]);
    mocked.questionRejectMock.mockResolvedValueOnce({
      data: undefined,
      error: { _tag: "FormAlreadySettledError", message: "settled" },
    });

    container.questionManager.startQuestions([QUESTION_ONE], "req-cancel-gone", "session-1");
    await showCurrentQuestion(api, 123, createDeps());
    await pressButton("question:cancel:0", 950, api);

    await vi.waitFor(() => {
      expect(container.questionManager.isActive()).toBe(false);
    });
    expect(editsOf(api, 950).join()).toContain(t("question.settled_outside.cancelled"));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Context } from "grammy";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  runGuestPromptMock: vi.fn(),
  findGuestThreadMock: vi.fn(),
  searchGuestSessionsMock: vi.fn(),
  connectGuestThreadMock: vi.fn(),
  watchGuestSessionMock: vi.fn(),
  describeGuestActivityMock: vi.fn(),
  isGuestThreadRunningMock: vi.fn(),
  config: { bot: { messageFormatMode: "markdown" } },
}));

vi.mock("../../../src/config.js", () => ({ config: mocked.config }));

vi.mock("../../../src/opencode/client.js", () => ({ opencodeClient: {} }));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/app/services/guest-session-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/app/services/guest-session-service.js")>();
  return {
    ...actual,
    runGuestPrompt: mocked.runGuestPromptMock,
    findGuestThread: mocked.findGuestThreadMock,
    searchGuestSessions: mocked.searchGuestSessionsMock,
    connectGuestThread: mocked.connectGuestThreadMock,
    watchGuestSession: mocked.watchGuestSessionMock,
    describeGuestActivity: mocked.describeGuestActivityMock,
    isGuestThreadRunning: mocked.isGuestThreadRunningMock,
  };
});

import {
  __resetGuestMessageHandlerForTests,
  handleGuestConnectCallback,
  handleGuestMessage,
  runGuestTurn,
} from "../../../src/bot/handlers/guest-message-handler.js";
import {
  GuestNoProjectError,
  type GuestSessionRef,
} from "../../../src/app/services/guest-session-service.js";
import { ScheduledTaskInteractiveRequestError } from "../../../src/app/services/scheduled-task-executor-service.js";
import type { GuestThreadInfo } from "../../../src/app/types/settings.js";

const GUEST_CHAT_ID = -100123;
const BOT_ID = 555;

const THREAD: GuestThreadInfo = {
  chatId: String(GUEST_CHAT_ID),
  sessionId: "session-1",
  directory: "/work/repo",
  replyKeys: [],
  messageIds: [],
  updatedAt: "2026-10-01T00:00:00.000Z",
};

// Runs the turn the way a guest message does, through the mocked prompt.
const promptRunner = (onSessionReady: (session: GuestSessionRef) => void) =>
  mocked.runGuestPromptMock("1", undefined, "hi", onSessionReady) as Promise<string>;

function pendingReply(): { promise: Promise<string>; finish: (reply: string) => void } {
  let finish: (reply: string) => void = () => {};
  const promise = new Promise<string>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

function createApi() {
  return {
    answerGuestQuery: vi.fn().mockResolvedValue({ inline_message_id: "inline-1" }),
    editMessageTextInline: vi.fn().mockResolvedValue(true),
  };
}

function createContext(
  api: ReturnType<typeof createApi>,
  message: Record<string, unknown> = {},
): Context {
  return {
    api,
    me: { id: BOT_ID, is_bot: true, username: "opencode_bot" },
    guestMessage: {
      message_id: 1,
      date: 0,
      guest_query_id: "query-1",
      chat: { id: GUEST_CHAT_ID, type: "supergroup", title: "Team chat" },
      text: "@opencode_bot what does this repo do?",
      ...message,
    },
  } as unknown as Context;
}

function answeredText(api: ReturnType<typeof createApi>, callIndex = 0): string {
  return api.answerGuestQuery.mock.calls[callIndex]?.[1]?.input_message_content?.message_text;
}

describe("bot/handlers/guest-message-handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.config.bot.messageFormatMode = "markdown";
    mocked.findGuestThreadMock.mockReturnValue(undefined);
    mocked.isGuestThreadRunningMock.mockReturnValue(false);
    mocked.describeGuestActivityMock.mockResolvedValue(null);
    __resetGuestMessageHandlerForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers with a placeholder and edits it into the reply", async () => {
    mocked.runGuestPromptMock.mockResolvedValue("It is a **bot**.");
    const api = createApi();

    await handleGuestMessage(createContext(api));

    expect(api.answerGuestQuery).toHaveBeenCalledTimes(1);
    expect(api.answerGuestQuery.mock.calls[0]?.[0]).toBe("query-1");
    expect(answeredText(api)).toBe(t("guest.thinking"));
    await vi.waitFor(() => expect(api.editMessageTextInline).toHaveBeenCalled());
    expect(mocked.findGuestThreadMock).toHaveBeenCalledWith(String(GUEST_CHAT_ID), undefined);
    expect(mocked.runGuestPromptMock).toHaveBeenCalledWith(
      String(GUEST_CHAT_ID),
      undefined,
      "what does this repo do?",
      expect.any(Function),
    );
    expect(api.editMessageTextInline).toHaveBeenCalledWith("inline-1", "It is a *bot*\\.", {
      parse_mode: "MarkdownV2",
    });
  });

  it("falls back to plain text when Telegram rejects the MarkdownV2 reply", async () => {
    mocked.runGuestPromptMock.mockResolvedValue("It is a **bot**.");
    const api = createApi();
    api.editMessageTextInline
      .mockRejectedValueOnce({ error_code: 400, description: "Bad Request: can't parse entities" })
      .mockResolvedValue(true);

    await handleGuestMessage(createContext(api));

    await vi.waitFor(() => expect(api.editMessageTextInline).toHaveBeenCalledTimes(2));
    expect(api.editMessageTextInline).toHaveBeenLastCalledWith("inline-1", "It is a **bot**.");
  });

  it("continues the conversation of the bot message it replies to", async () => {
    mocked.findGuestThreadMock.mockReturnValue(THREAD);
    mocked.runGuestPromptMock.mockResolvedValue("ok");
    const api = createApi();

    await handleGuestMessage(
      createContext(api, {
        text: "what did I ask before?",
        reply_to_message: {
          message_id: 41,
          text: "Hello. What can I help you with?",
          from: { id: 42, is_bot: false },
          via_bot: { id: BOT_ID, is_bot: true },
        },
      }),
    );

    expect(mocked.findGuestThreadMock).toHaveBeenCalledWith(String(GUEST_CHAT_ID), {
      messageId: 41,
      text: "Hello. What can I help you with?",
    });
    expect(mocked.runGuestPromptMock).toHaveBeenCalledWith(
      String(GUEST_CHAT_ID),
      THREAD,
      "what did I ask before?",
      expect.any(Function),
    );
  });

  it("starts a new conversation for a reply to someone else's message", async () => {
    mocked.runGuestPromptMock.mockResolvedValue("ok");
    const api = createApi();

    await handleGuestMessage(
      createContext(api, {
        reply_to_message: { message_id: 3, text: "hi", from: { id: 42, is_bot: false } },
      }),
    );

    expect(mocked.findGuestThreadMock).toHaveBeenCalledWith(String(GUEST_CHAT_ID), undefined);
  });

  it("puts the message a mention replies to in front of the request", async () => {
    mocked.runGuestPromptMock.mockResolvedValue("ok");
    const api = createApi();

    await handleGuestMessage(
      createContext(api, {
        text: "@opencode_bot what did I ask?",
        reply_to_message: {
          message_id: 3,
          text: "guess a number and give me options",
          from: { id: 42, is_bot: false, first_name: "Alex", last_name: "Donec" },
        },
      }),
    );

    expect(mocked.runGuestPromptMock.mock.calls[0]?.[2]).toBe(
      'Message from Alex Donec this request replies to:\n"""\nguess a number and give me options\n"""\n\nwhat did I ask?',
    );
  });

  it("uses only the quoted part of the message when there is one", async () => {
    mocked.runGuestPromptMock.mockResolvedValue("ok");
    const api = createApi();

    await handleGuestMessage(
      createContext(api, {
        text: "@opencode_bot",
        quote: { text: "options", position: 28 },
        reply_to_message: {
          message_id: 3,
          text: "guess a number and give me options",
          sender_chat: { id: -1, type: "channel", title: "News" },
        },
      }),
    );

    // A bare mention in reply to a message asks about that message.
    expect(mocked.runGuestPromptMock.mock.calls[0]?.[2]).toBe(
      'Message from News this request replies to:\n"""\noptions\n"""',
    );
  });

  it("tells a reply to wait while its conversation is still running", async () => {
    mocked.findGuestThreadMock.mockReturnValue(THREAD);
    mocked.isGuestThreadRunningMock.mockReturnValue(true);
    const api = createApi();

    await handleGuestMessage(createContext(api));

    expect(answeredText(api)).toBe(t("guest.busy"));
    expect(mocked.runGuestPromptMock).not.toHaveBeenCalled();
  });

  it("runs separate conversations side by side, up to three per chat", async () => {
    const pending = pendingReply();
    mocked.runGuestPromptMock.mockReturnValue(pending.promise);
    const api = createApi();

    for (const queryId of ["q-1", "q-2", "q-3", "q-4"]) {
      await handleGuestMessage(createContext(api, { guest_query_id: queryId }));
    }

    expect(mocked.runGuestPromptMock).toHaveBeenCalledTimes(3);
    expect(answeredText(api, 3)).toBe(t("guest.too_many"));

    pending.finish("done");
    await vi.waitFor(() => expect(api.editMessageTextInline).toHaveBeenCalledTimes(3));

    mocked.runGuestPromptMock.mockResolvedValue("again");
    await handleGuestMessage(createContext(api, { guest_query_id: "q-5" }));
    expect(answeredText(api, 4)).toBe(t("guest.thinking"));
  });

  it("refuses slash commands without starting a turn", async () => {
    const api = createApi();

    await handleGuestMessage(createContext(api, { text: "@opencode_bot /status" }));

    expect(answeredText(api)).toBe(t("guest.command_unsupported"));
    expect(mocked.runGuestPromptMock).not.toHaveBeenCalled();
  });

  it("refuses a mention with no request text", async () => {
    const api = createApi();

    await handleGuestMessage(createContext(api, { text: "@opencode_bot" }));

    expect(answeredText(api)).toBe(t("guest.empty"));
    expect(mocked.runGuestPromptMock).not.toHaveBeenCalled();
  });

  it("refuses messages that are not text", async () => {
    const api = createApi();

    await handleGuestMessage(
      createContext(api, { text: undefined, caption: "@opencode_bot look", photo: [] }),
    );

    expect(answeredText(api)).toBe(t("guest.unsupported_message"));
    expect(mocked.runGuestPromptMock).not.toHaveBeenCalled();
  });

  it("ignores a guest message without a query id", async () => {
    const api = createApi();

    await handleGuestMessage(createContext(api, { guest_query_id: undefined }));

    expect(api.answerGuestQuery).not.toHaveBeenCalled();
  });

  it("does not start a turn when the placeholder could not be posted", async () => {
    const api = createApi();
    api.answerGuestQuery.mockRejectedValueOnce(new Error("query expired"));

    await handleGuestMessage(createContext(api));

    expect(mocked.runGuestPromptMock).not.toHaveBeenCalled();
  });

  describe("runGuestTurn", () => {
    it.each([
      [new ScheduledTaskInteractiveRequestError("permission"), "guest.error.interactive"],
      [new GuestNoProjectError(), "guest.error.no_project"],
      [new Error("boom"), "guest.error.generic"],
    ] as const)("reports %s on the guest message", async (error, key) => {
      mocked.runGuestPromptMock.mockRejectedValue(error);
      const api = createApi();

      await runGuestTurn(api as unknown as Api, "inline-1", "1", promptRunner);

      expect(api.editMessageTextInline).toHaveBeenCalledWith("inline-1", t(key));
    });

    it("shortens a reply that does not fit in one Telegram message", async () => {
      mocked.config.bot.messageFormatMode = "raw";
      mocked.runGuestPromptMock.mockResolvedValue("x".repeat(5000));
      const api = createApi();

      await runGuestTurn(api as unknown as Api, "inline-1", "1", promptRunner);

      const text = api.editMessageTextInline.mock.calls[0]?.[1] as string;
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text.endsWith(t("guest.truncated"))).toBe(true);
    });

    it("shows elapsed time and the session's latest action while the turn runs", async () => {
      vi.useFakeTimers();
      const pending = pendingReply();
      mocked.runGuestPromptMock.mockImplementation(
        (
          _chatId: string,
          _thread: unknown,
          _text: string,
          onSessionReady: (s: unknown) => void,
        ) => {
          onSessionReady({ sessionId: "session-1", directory: "/work/repo" });
          return pending.promise;
        },
      );
      mocked.describeGuestActivityMock.mockResolvedValue("💻 bash virsh list --all");
      mocked.config.bot.messageFormatMode = "raw";
      const api = createApi();

      const turn = runGuestTurn(api as unknown as Api, "inline-1", "1", promptRunner);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mocked.describeGuestActivityMock).toHaveBeenCalledWith({
        sessionId: "session-1",
        directory: "/work/repo",
      });
      expect(api.editMessageTextInline).toHaveBeenCalledWith(
        "inline-1",
        `${t("guest.working", { elapsed: "10s" })}\n\n💻 bash virsh list --all`,
      );

      pending.finish("done");
      await turn;
      const editsAfterReply = api.editMessageTextInline.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.editMessageTextInline).toHaveBeenCalledTimes(editsAfterReply);
      expect(api.editMessageTextInline).toHaveBeenLastCalledWith("inline-1", "done");
    });

    it("shows only the elapsed time before the session has an action to show", async () => {
      vi.useFakeTimers();
      const pending = pendingReply();
      mocked.runGuestPromptMock.mockReturnValue(pending.promise);
      mocked.config.bot.messageFormatMode = "raw";
      const api = createApi();

      const turn = runGuestTurn(api as unknown as Api, "inline-1", "1", promptRunner);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mocked.describeGuestActivityMock).not.toHaveBeenCalled();
      expect(api.editMessageTextInline).toHaveBeenCalledWith(
        "inline-1",
        t("guest.working", { elapsed: "10s" }),
      );
      pending.finish("done");
      await turn;
    });

    it("never lets a late progress edit replace the reply", async () => {
      vi.useFakeTimers();
      const pending = pendingReply();
      const activity = pendingReply();
      mocked.runGuestPromptMock.mockImplementation(
        (
          _chatId: string,
          _thread: unknown,
          _text: string,
          onSessionReady: (s: unknown) => void,
        ) => {
          onSessionReady({ sessionId: "session-1", directory: "/work/repo" });
          return pending.promise;
        },
      );
      mocked.describeGuestActivityMock.mockReturnValue(activity.promise);
      mocked.config.bot.messageFormatMode = "raw";
      const api = createApi();

      const turn = runGuestTurn(api as unknown as Api, "inline-1", "1", promptRunner);
      await vi.advanceTimersByTimeAsync(10_000);
      pending.finish("done");
      await vi.advanceTimersByTimeAsync(0);
      activity.finish("💻 bash ls");
      await turn;

      expect(api.editMessageTextInline).toHaveBeenCalledTimes(1);
      expect(api.editMessageTextInline).toHaveBeenLastCalledWith("inline-1", "done");
    });
  });

  describe("connect", () => {
    const SESSIONS = [
      { id: "ses-a", title: "Check VMs on the host", directory: "/home/alex/infra" },
      { id: "ses-b", title: "vm migration", directory: "C:\\work\\dm" },
    ];

    function createTapContext(
      api: ReturnType<typeof createApi>,
      data: string,
      inlineMessageId = "inline-1",
    ): { ctx: Context; answerCallbackQuery: ReturnType<typeof vi.fn> } {
      const answerCallbackQuery = vi.fn().mockResolvedValue(true);
      const ctx = {
        api,
        callbackQuery: { id: "cb-1", data, inline_message_id: inlineMessageId },
        answerCallbackQuery,
      } as unknown as Context;
      return { ctx, answerCallbackQuery };
    }

    it("offers the sessions the search found as buttons", async () => {
      mocked.searchGuestSessionsMock.mockResolvedValue(SESSIONS);
      const api = createApi();

      await handleGuestMessage(createContext(api, { text: "@opencode_bot connect vm" }));

      expect(mocked.searchGuestSessionsMock).toHaveBeenCalledWith("vm");
      expect(mocked.runGuestPromptMock).not.toHaveBeenCalled();
      const result = api.answerGuestQuery.mock.calls[0]?.[1];
      expect(result.input_message_content.message_text).toBe(t("guest.connect.pick"));
      expect(result.reply_markup.inline_keyboard).toEqual([
        [{ text: "Check VMs on the host · infra", callback_data: "gcon:0" }],
        [{ text: "vm migration · dm", callback_data: "gcon:1" }],
        [{ text: t("guest.connect.cancel"), callback_data: "gcon:cancel" }],
      ]);
    });

    it("lists recent sessions for a bare connect", async () => {
      mocked.searchGuestSessionsMock.mockResolvedValue(SESSIONS);
      const api = createApi();

      await handleGuestMessage(createContext(api, { text: "@opencode_bot Connect" }));

      expect(mocked.searchGuestSessionsMock).toHaveBeenCalledWith("");
    });

    it("says so when no session matches", async () => {
      mocked.searchGuestSessionsMock.mockResolvedValue([]);
      const api = createApi();

      await handleGuestMessage(createContext(api, { text: "@opencode_bot connect nothing" }));

      expect(answeredText(api)).toBe(t("guest.connect.none", { query: "nothing" }));
    });

    it("connects the tapped session and turns the list into its reply", async () => {
      mocked.searchGuestSessionsMock.mockResolvedValue(SESSIONS);
      mocked.connectGuestThreadMock.mockResolvedValue(THREAD);
      mocked.watchGuestSessionMock.mockResolvedValue("All VMs are running.");
      mocked.config.bot.messageFormatMode = "raw";
      const api = createApi();
      await handleGuestMessage(createContext(api, { text: "@opencode_bot connect vm" }));

      const { ctx, answerCallbackQuery } = createTapContext(api, "gcon:1");
      await handleGuestConnectCallback(ctx);

      expect(answerCallbackQuery).toHaveBeenCalledWith();
      expect(mocked.connectGuestThreadMock).toHaveBeenCalledWith(
        String(GUEST_CHAT_ID),
        SESSIONS[1],
      );
      expect(api.editMessageTextInline).toHaveBeenCalledWith(
        "inline-1",
        t("guest.connect.connecting", { title: "vm migration" }),
      );
      await vi.waitFor(() =>
        expect(api.editMessageTextInline).toHaveBeenLastCalledWith(
          "inline-1",
          "All VMs are running.",
        ),
      );
      expect(mocked.watchGuestSessionMock).toHaveBeenCalledWith(
        String(GUEST_CHAT_ID),
        THREAD,
        expect.any(Function),
      );
    });

    it("collapses the list on Cancel and connects nothing", async () => {
      mocked.searchGuestSessionsMock.mockResolvedValue(SESSIONS);
      const api = createApi();
      await handleGuestMessage(createContext(api, { text: "@opencode_bot connect vm" }));

      const cancel = createTapContext(api, "gcon:cancel");
      await handleGuestConnectCallback(cancel.ctx);
      const late = createTapContext(api, "gcon:0");
      await handleGuestConnectCallback(late.ctx);

      expect(cancel.answerCallbackQuery).toHaveBeenCalledWith();
      expect(api.editMessageTextInline).toHaveBeenCalledWith(
        "inline-1",
        t("guest.connect.cancelled"),
      );
      expect(late.answerCallbackQuery).toHaveBeenCalledWith({ text: t("guest.connect.expired") });
      expect(mocked.connectGuestThreadMock).not.toHaveBeenCalled();
    });

    it("cancels a list from before a restart too", async () => {
      const api = createApi();

      await handleGuestConnectCallback(createTapContext(api, "gcon:cancel", "inline-old").ctx);

      expect(api.editMessageTextInline).toHaveBeenCalledWith(
        "inline-old",
        t("guest.connect.cancelled"),
      );
    });

    it("answers a tap on a list it no longer has as expired", async () => {
      mocked.searchGuestSessionsMock.mockResolvedValue(SESSIONS);
      mocked.connectGuestThreadMock.mockResolvedValue(THREAD);
      mocked.watchGuestSessionMock.mockResolvedValue("ok");
      const api = createApi();
      await handleGuestMessage(createContext(api, { text: "@opencode_bot connect vm" }));
      await handleGuestConnectCallback(createTapContext(api, "gcon:0").ctx);

      // The list was used up by the first tap.
      const second = createTapContext(api, "gcon:1");
      await handleGuestConnectCallback(second.ctx);
      const unknown = createTapContext(api, "gcon:0", "inline-unknown");
      await handleGuestConnectCallback(unknown.ctx);

      expect(second.answerCallbackQuery).toHaveBeenCalledWith({ text: t("guest.connect.expired") });
      expect(unknown.answerCallbackQuery).toHaveBeenCalledWith({
        text: t("guest.connect.expired"),
      });
      expect(mocked.connectGuestThreadMock).toHaveBeenCalledTimes(1);
    });

    it("tells a tap to wait when the session is already followed in this chat", async () => {
      mocked.searchGuestSessionsMock.mockResolvedValue(SESSIONS);
      mocked.connectGuestThreadMock.mockResolvedValue(THREAD);
      mocked.isGuestThreadRunningMock.mockReturnValue(true);
      const api = createApi();
      await handleGuestMessage(createContext(api, { text: "@opencode_bot connect vm" }));

      await handleGuestConnectCallback(createTapContext(api, "gcon:0").ctx);

      expect(api.editMessageTextInline).toHaveBeenCalledWith("inline-1", t("guest.busy"));
      expect(mocked.watchGuestSessionMock).not.toHaveBeenCalled();
    });

    it("reports a session with no reply yet", async () => {
      const { GuestNoReplyError } =
        await import("../../../src/app/services/guest-session-service.js");
      mocked.watchGuestSessionMock.mockRejectedValue(new GuestNoReplyError());
      const api = createApi();

      await runGuestTurn(api as unknown as Api, "inline-1", "1", (ready) =>
        mocked.watchGuestSessionMock("1", THREAD, ready),
      );

      expect(api.editMessageTextInline).toHaveBeenCalledWith(
        "inline-1",
        t("guest.connect.no_reply"),
      );
    });
  });
});

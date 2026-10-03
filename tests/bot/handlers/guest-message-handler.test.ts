import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Context } from "grammy";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  runGuestPromptMock: vi.fn(),
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
  return { ...actual, runGuestPrompt: mocked.runGuestPromptMock };
});

import {
  __resetGuestMessageHandlerForTests,
  handleGuestMessage,
  runGuestTurn,
} from "../../../src/bot/handlers/guest-message-handler.js";
import { GuestNoProjectError } from "../../../src/app/services/guest-session-service.js";
import { ScheduledTaskInteractiveRequestError } from "../../../src/app/services/scheduled-task-executor-service.js";

const GUEST_CHAT_ID = -100123;

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
    me: { id: 555, is_bot: true, username: "opencode_bot" },
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
    expect(mocked.runGuestPromptMock).toHaveBeenCalledWith(
      String(GUEST_CHAT_ID),
      "Team chat",
      "what does this repo do?",
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

  it("tells a second mention to wait while the chat's turn is still running", async () => {
    let finishTurn: (reply: string) => void = () => {};
    mocked.runGuestPromptMock.mockReturnValue(
      new Promise<string>((resolve) => {
        finishTurn = resolve;
      }),
    );
    const api = createApi();

    await handleGuestMessage(createContext(api));
    await handleGuestMessage(createContext(api, { guest_query_id: "query-2" }));

    expect(api.answerGuestQuery).toHaveBeenCalledTimes(2);
    expect(api.answerGuestQuery.mock.calls[1]?.[0]).toBe("query-2");
    expect(answeredText(api, 1)).toBe(t("guest.busy"));
    expect(mocked.runGuestPromptMock).toHaveBeenCalledTimes(1);

    finishTurn("done");
    await vi.waitFor(() => expect(api.editMessageTextInline).toHaveBeenCalled());

    // The chat is free again once the first turn finished.
    mocked.runGuestPromptMock.mockResolvedValue("again");
    await handleGuestMessage(createContext(api, { guest_query_id: "query-3" }));
    expect(answeredText(api, 2)).toBe(t("guest.thinking"));
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

      await runGuestTurn(api as unknown as Api, "inline-1", "1", "Chat", "hi");

      expect(api.editMessageTextInline).toHaveBeenCalledWith("inline-1", t(key));
    });

    it("shortens a reply that does not fit in one Telegram message", async () => {
      mocked.config.bot.messageFormatMode = "raw";
      mocked.runGuestPromptMock.mockResolvedValue("x".repeat(5000));
      const api = createApi();

      await runGuestTurn(api as unknown as Api, "inline-1", "1", "Chat", "hi");

      const text = api.editMessageTextInline.mock.calls[0]?.[1] as string;
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text.endsWith(t("guest.truncated"))).toBe(true);
    });

    it("shows elapsed time on the placeholder while the turn runs", async () => {
      vi.useFakeTimers();
      let finishTurn: (reply: string) => void = () => {};
      mocked.runGuestPromptMock.mockReturnValue(
        new Promise<string>((resolve) => {
          finishTurn = resolve;
        }),
      );
      mocked.config.bot.messageFormatMode = "raw";
      const api = createApi();

      const turn = runGuestTurn(api as unknown as Api, "inline-1", "1", "Chat", "hi");
      await vi.advanceTimersByTimeAsync(15_000);

      expect(api.editMessageTextInline).toHaveBeenCalledWith(
        "inline-1",
        expect.stringContaining(t("guest.working", { elapsed: "" }).trim()),
      );

      finishTurn("done");
      await turn;
      const editsAfterReply = api.editMessageTextInline.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.editMessageTextInline).toHaveBeenCalledTimes(editsAfterReply);
      expect(api.editMessageTextInline).toHaveBeenLastCalledWith("inline-1", "done");
    });
  });
});

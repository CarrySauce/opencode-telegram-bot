import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { defined } from "../../helpers/defined.js";
import { createIncomingPrompt } from "../../../src/app/types/prompt.js";

const processUserPromptMock = vi.hoisted(() => vi.fn());
const getPromptQueueModeMock = vi.hoisted(() => vi.fn());
const isForegroundBusyMock = vi.hoisted(() => vi.fn());
const getKeyboardMock = vi.hoisted(() => vi.fn());
const sendBotTextMock = vi.hoisted(() => vi.fn());
const getCurrentSettingsSessionMock = vi.hoisted(() => vi.fn());
const handOverPreparedPromptMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/bot/handlers/prompt-handover.js", () => ({
  handOverPreparedPrompt: handOverPreparedPromptMock,
}));

vi.mock("../../../src/bot/handlers/prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/bot/handlers/prompt.js")>()),
  processUserPrompt: processUserPromptMock,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getPromptQueueMode: getPromptQueueModeMock,
  getCurrentSession: getCurrentSettingsSessionMock,
}));

vi.mock("../../../src/app/services/run-control-service.js", () => ({
  isForegroundBusy: isForegroundBusyMock,
}));

vi.mock("../../../src/bot/messages/telegram-text.js", () => ({
  sendBotText: sendBotTextMock,
}));

import { MAX_QUEUED_PROMPTS, promptQueue } from "../../../src/app/managers/prompt-queue-manager.js";
import { promptHandover } from "../../../src/app/managers/prompt-handover-manager.js";
import {
  __resetPromptQueueDispatchForTests,
  dispatchNextQueuedPrompt,
  initializePromptQueueDispatch,
  shouldSuggestPromptQueue as shouldSuggestPromptQueueInput,
  takeArrivalTicket,
  tryEnqueuePrompt as tryEnqueueInput,
  tryEnqueuePromptIfBusy,
} from "../../../src/bot/handlers/prompt-queue-dispatch.js";
import type { AppContainer } from "../../../src/app/bootstrap/app-container.js";
import { createTestAppContainer } from "../../helpers/app-container.js";

const DEPS = {
  ...createTestAppContainer({
    keyboardManager: { getKeyboard: getKeyboardMock } as unknown as AppContainer["keyboardManager"],
  }),
  bot: {} as never,
};
const KEYBOARD = { keyboard: [] };

let replyMock: ReturnType<typeof vi.fn>;

function makeContext(): Context {
  return {
    chat: { id: 42 },
    api: { sendMessage: vi.fn() },
    reply: replyMock,
  } as unknown as Context;
}

function tryEnqueuePrompt(ctx: Context, text: string): Promise<boolean> {
  return tryEnqueueInput(ctx, createIncomingPrompt(text));
}

function shouldSuggestPromptQueue(text: string): boolean {
  return shouldSuggestPromptQueueInput(createIncomingPrompt(text));
}

describe("bot/handlers/prompt-queue-dispatch", () => {
  beforeEach(() => {
    promptQueue.__resetForTests();
    promptHandover.__resetForTests();
    __resetPromptQueueDispatchForTests();
    getCurrentSettingsSessionMock.mockReset().mockReturnValue(undefined);
    handOverPreparedPromptMock.mockReset().mockResolvedValue(true);
    replyMock = vi.fn().mockResolvedValue(undefined);
    processUserPromptMock.mockReset().mockResolvedValue(true);
    getPromptQueueModeMock.mockReset().mockReturnValue("queue");
    isForegroundBusyMock.mockReset().mockReturnValue(false);
    getKeyboardMock.mockReset().mockReturnValue(KEYBOARD);
    sendBotTextMock.mockReset().mockResolvedValue(undefined);
    initializePromptQueueDispatch(DEPS);
  });

  describe("prompts handed over at /detach", () => {
    const SESSION = { id: "ses-1", title: "Session", directory: "D:/repo" };
    const SELECTION = { agent: "build", providerID: "p", modelID: "m" };

    function handOverOnePrompt(): void {
      promptHandover.recordDetach(SESSION, SELECTION);
      promptHandover.addPrompt("ses-1", { ...createIncomingPrompt("handed over"), selection: SELECTION });
    }

    it("queues a message sent after re-attaching behind them while the session is idle", async () => {
      handOverOnePrompt();
      getCurrentSettingsSessionMock.mockReturnValue(SESSION);

      await expect(
        tryEnqueuePromptIfBusy(makeContext(), createIncomingPrompt("after re-attach")),
      ).resolves.toBe(true);
      await dispatchNextQueuedPrompt();

      expect(promptQueue.list().map((item) => item.text)).toEqual(["after re-attach"]);
      expect(processUserPromptMock).not.toHaveBeenCalled();
    });

    it("leaves messages of another session alone", async () => {
      handOverOnePrompt();
      getCurrentSettingsSessionMock.mockReturnValue({ ...SESSION, id: "ses-2" });

      await expect(
        tryEnqueuePromptIfBusy(makeContext(), createIncomingPrompt("elsewhere")),
      ).resolves.toBe(false);
    });

    it("takes an arrival ticket only while the message would wait", () => {
      getCurrentSettingsSessionMock.mockReturnValue(SESSION);
      expect(takeArrivalTicket()).toBeUndefined();

      isForegroundBusyMock.mockReturnValue(true);
      expect(takeArrivalTicket()).toEqual({ sessionId: "ses-1", detachSeq: 0 });

      getPromptQueueModeMock.mockReturnValue("off");
      expect(takeArrivalTicket()).toBeUndefined();
    });

    it("hands a message prepared across /detach over to its session instead of queueing it", async () => {
      getCurrentSettingsSessionMock.mockReturnValue(SESSION);
      isForegroundBusyMock.mockReturnValue(true);
      const ticket = takeArrivalTicket();
      promptHandover.recordDetach(SESSION, SELECTION);
      getCurrentSettingsSessionMock.mockReturnValue(undefined);
      isForegroundBusyMock.mockReturnValue(false);

      const ctx = makeContext();
      const input = createIncomingPrompt("transcribed");

      await expect(tryEnqueuePromptIfBusy(ctx, input, ticket)).resolves.toBe(true);

      expect(handOverPreparedPromptMock).toHaveBeenCalledWith(ctx, ticket, input);
      expect(promptQueue.size()).toBe(0);
      expect(replyMock).not.toHaveBeenCalled();
    });

    it("keeps the normal path for a ticket whose session was not detached since", async () => {
      getCurrentSettingsSessionMock.mockReturnValue(SESSION);
      isForegroundBusyMock.mockReturnValue(true);
      const ticket = takeArrivalTicket();

      await expect(
        tryEnqueuePromptIfBusy(makeContext(), createIncomingPrompt("still busy"), ticket),
      ).resolves.toBe(true);

      expect(handOverPreparedPromptMock).not.toHaveBeenCalled();
      expect(promptQueue.list().map((item) => item.text)).toEqual(["still busy"]);
    });
  });

  describe("tryEnqueuePrompt", () => {
    it("does nothing when the setting is disabled", async () => {
      getPromptQueueModeMock.mockReturnValue("off");

      await expect(tryEnqueuePrompt(makeContext(), "do the thing")).resolves.toBe(false);
      expect(promptQueue.size()).toBe(0);
      expect(replyMock).not.toHaveBeenCalled();
    });

    it("queues the prompt and confirms with the refreshed keyboard", async () => {
      await expect(tryEnqueuePrompt(makeContext(), "do the thing")).resolves.toBe(true);

      expect(promptQueue.list().map((item) => item.text)).toEqual(["do the thing"]);
      expect(replyMock).toHaveBeenCalledTimes(1);
      expect(defined(replyMock.mock.calls[0]?.[1])).toEqual({ reply_markup: KEYBOARD });
    });

    it("rejects a prompt once the queue is full and keeps the queue intact", async () => {
      const ctx = makeContext();
      for (let index = 0; index < MAX_QUEUED_PROMPTS; index++) {
        await tryEnqueuePrompt(ctx, `prompt ${index}`);
      }
      replyMock.mockClear();

      await expect(tryEnqueuePrompt(ctx, "overflow")).resolves.toBe(true);

      expect(promptQueue.size()).toBe(MAX_QUEUED_PROMPTS);
      expect(promptQueue.list().map((item) => item.text)).not.toContain("overflow");
      expect(replyMock).toHaveBeenCalledTimes(1);
    });

    it("never queues reply keyboard button presses", async () => {
      const ctx = makeContext();

      await expect(tryEnqueuePrompt(ctx, "🧠 openrouter\nopenai/gpt-4o")).resolves.toBe(false);
      await expect(tryEnqueuePrompt(ctx, "🛠️ Build Agent")).resolves.toBe(false);
      await expect(tryEnqueuePrompt(ctx, "💡 Default")).resolves.toBe(false);
      await expect(tryEnqueuePrompt(ctx, "📊 150K / 1.5M (10%)")).resolves.toBe(false);
      await expect(tryEnqueuePrompt(ctx, "❌ 1. queued")).resolves.toBe(false);

      expect(promptQueue.size()).toBe(0);
    });

    it("never queues commands or blank text", async () => {
      const ctx = makeContext();

      await expect(tryEnqueuePrompt(ctx, "/status")).resolves.toBe(false);
      await expect(tryEnqueuePrompt(ctx, "   ")).resolves.toBe(false);

      expect(promptQueue.size()).toBe(0);
    });
  });

  describe("shouldSuggestPromptQueue", () => {
    it("suggests the queue for a plain prompt while the setting is disabled", () => {
      getPromptQueueModeMock.mockReturnValue("off");

      expect(shouldSuggestPromptQueue("do the thing")).toBe(true);
    });

    it("stays quiet once the setting is enabled", () => {
      expect(shouldSuggestPromptQueue("do the thing")).toBe(false);
    });

    it("stays quiet for commands, blank text, and button presses", () => {
      getPromptQueueModeMock.mockReturnValue("off");

      expect(shouldSuggestPromptQueue("/status")).toBe(false);
      expect(shouldSuggestPromptQueue("   ")).toBe(false);
      expect(shouldSuggestPromptQueue("🧠 openrouter\nopenai/gpt-4o")).toBe(false);
      expect(shouldSuggestPromptQueue("🛠️ Build Agent")).toBe(false);
      expect(shouldSuggestPromptQueue("📊 150K / 1.5M (10%)")).toBe(false);
      expect(shouldSuggestPromptQueue("❌ 1. queued")).toBe(false);
    });
  });

  describe("dispatchNextQueuedPrompt", () => {
    it("does nothing when the queue is empty", async () => {
      await dispatchNextQueuedPrompt();

      expect(processUserPromptMock).not.toHaveBeenCalled();
      expect(sendBotTextMock).not.toHaveBeenCalled();
    });

    it("does nothing while the session is still busy", async () => {
      await tryEnqueuePrompt(makeContext(), "do the thing");
      isForegroundBusyMock.mockReturnValue(true);

      await dispatchNextQueuedPrompt();

      expect(processUserPromptMock).not.toHaveBeenCalled();
      expect(promptQueue.size()).toBe(1);
    });

    it("sends the first prompt and echoes it as external user input", async () => {
      const ctx = makeContext();
      await tryEnqueuePrompt(ctx, "first");
      await tryEnqueuePrompt(ctx, "second");

      await dispatchNextQueuedPrompt();

      expect(sendBotTextMock).toHaveBeenCalledTimes(1);
      const echo = defined(sendBotTextMock.mock.calls[0]?.[0]);
      expect(echo.text).toContain("first");
      expect(echo.rawFallbackText).toContain("👤");
      expect(echo.rawFallbackText).toContain("> first");
      expect(echo.format).toBe("markdown_v2");
      expect(echo.options).toEqual({ reply_markup: KEYBOARD });

      expect(processUserPromptMock).toHaveBeenCalledTimes(1);
      expect(defined(processUserPromptMock.mock.calls[0]?.[1]).text).toBe("first");
      expect(defined(processUserPromptMock.mock.calls[0]?.[2])).toBe(DEPS);
      expect(promptQueue.list().map((item) => item.text)).toEqual(["second"]);
    });

    it("dispatches queued media with its prepared file parts", async () => {
      const ctx = makeContext();
      const filePart = {
        type: "file" as const,
        mime: "image/jpeg",
        filename: "photo.jpg",
        url: "data:image/jpeg;base64,cGhvdG8=",
      };
      await tryEnqueueInput(ctx, {
        ...createIncomingPrompt("inspect this", { fileParts: [filePart] }),
        displayText: "release screenshot",
      });

      await dispatchNextQueuedPrompt();

      expect(processUserPromptMock).toHaveBeenCalledWith(
        ctx,
        {
          id: "queued-1",
          text: "inspect this",
          fileParts: [filePart],
          photos: [],
          displayText: "release screenshot",
          mediaBytes: 0,
        },
        DEPS,
        {},
      );
      expect(defined(sendBotTextMock.mock.calls[0]?.[0]).rawFallbackText).toContain(
        "release screenshot",
      );
    });

    it("drains the queue one prompt per idle transition", async () => {
      const ctx = makeContext();
      await tryEnqueuePrompt(ctx, "first");
      await tryEnqueuePrompt(ctx, "second");

      await dispatchNextQueuedPrompt();
      await dispatchNextQueuedPrompt();

      expect(processUserPromptMock.mock.calls.map((call) => call[1].text)).toEqual([
        "first",
        "second",
      ]);
      expect(promptQueue.size()).toBe(0);
    });

    it("takes only one prompt when two idle events overlap", async () => {
      const ctx = makeContext();
      await tryEnqueuePrompt(ctx, "first");
      await tryEnqueuePrompt(ctx, "second");

      // processUserPrompt marks the session busy only after several awaited
      // round-trips, so a second drain must not slip through meanwhile.
      let releaseFirstDispatch: () => void = () => {};
      processUserPromptMock.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseFirstDispatch = () => resolve(true);
          }),
      );

      const firstDispatch = dispatchNextQueuedPrompt();
      await dispatchNextQueuedPrompt();

      expect(processUserPromptMock).toHaveBeenCalledTimes(1);
      expect(promptQueue.list().map((item) => item.text)).toEqual(["second"]);

      releaseFirstDispatch();
      await firstDispatch;

      await dispatchNextQueuedPrompt();

      expect(processUserPromptMock.mock.calls.map((call) => call[1].text)).toEqual([
        "first",
        "second",
      ]);
    });

    it("does not requeue a prompt that could not be dispatched", async () => {
      processUserPromptMock.mockResolvedValue(false);
      await tryEnqueuePrompt(makeContext(), "first");

      await dispatchNextQueuedPrompt();

      expect(promptQueue.size()).toBe(0);
    });

    it("still sends the prompt when the echo fails", async () => {
      sendBotTextMock.mockRejectedValue(new Error("telegram down"));
      await tryEnqueuePrompt(makeContext(), "first");

      await dispatchNextQueuedPrompt();

      expect(processUserPromptMock).toHaveBeenCalledTimes(1);
    });

    it("does nothing when dispatch was never initialized", async () => {
      await tryEnqueuePrompt(makeContext(), "first");
      __resetPromptQueueDispatchForTests();

      await dispatchNextQueuedPrompt();

      expect(processUserPromptMock).not.toHaveBeenCalled();
      expect(promptQueue.size()).toBe(1);
    });
  });
});

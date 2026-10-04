import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestThreadInfo } from "../../../src/app/types/settings.js";

const mocked = vi.hoisted(() => ({
  createMock: vi.fn(),
  getMock: vi.fn(),
  promptAsyncMock: vi.fn(),
  waitMock: vi.fn(),
  registerIgnoreMock: vi.fn(),
  getCurrentProjectMock: vi.fn(),
  resolveProjectAgentMock: vi.fn(),
  getStoredModelMock: vi.fn(),
  storedThreads: [] as GuestThreadInfo[],
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      create: mocked.createMock,
      get: mocked.getMock,
      promptAsync: mocked.promptAsyncMock,
    },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: mocked.getCurrentProjectMock,
  getGuestThreads: () => structuredClone(mocked.storedThreads),
  setGuestThreads: async (threads: GuestThreadInfo[]) => {
    mocked.storedThreads = structuredClone(threads);
  },
}));

vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  getStoredAgent: () => "plan",
  resolveProjectAgent: mocked.resolveProjectAgentMock,
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: mocked.getStoredModelMock,
}));

vi.mock("../../../src/app/services/scheduled-task-executor-service.js", () => ({
  waitForScheduledTaskResult: mocked.waitMock,
}));

vi.mock("../../../src/app/services/scheduled-task-session-ignore-service.js", () => ({
  registerScheduledTaskSessionIgnore: mocked.registerIgnoreMock,
}));

import {
  __resetGuestSessionsForTests,
  findGuestThread,
  GuestNoProjectError,
  guestReplyKey,
  isGuestThreadRunning,
  runGuestPrompt,
} from "../../../src/app/services/guest-session-service.js";

const PROJECT_DIR = "/work/repo";
const CHAT_ID = "-100";

function storedThread(partial: Partial<GuestThreadInfo> = {}): GuestThreadInfo {
  return {
    chatId: CHAT_ID,
    sessionId: "old-session",
    directory: PROJECT_DIR,
    replyKeys: [],
    messageIds: [],
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...partial,
  };
}

describe("app/services/guest-session-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetGuestSessionsForTests();
    mocked.storedThreads = [];
    mocked.getCurrentProjectMock.mockReturnValue({ id: "p1", worktree: PROJECT_DIR });
    mocked.createMock.mockResolvedValue({
      data: { id: "new-session", directory: PROJECT_DIR },
      error: undefined,
    });
    mocked.getMock.mockResolvedValue({ data: { id: "old-session" }, error: undefined });
    mocked.promptAsyncMock.mockResolvedValue({ data: undefined, error: undefined });
    mocked.waitMock.mockResolvedValue("The **answer** is 42.");
    mocked.resolveProjectAgentMock.mockResolvedValue("plan");
    mocked.getStoredModelMock.mockReturnValue({
      providerID: "openai",
      modelID: "gpt-5",
      variant: "high",
    });
  });

  describe("guestReplyKey", () => {
    it("matches the Markdown the bot sent to the text Telegram rendered", () => {
      expect(guestReplyKey("The **answer** is `42`.\n\n- one")).toBe(
        guestReplyKey("The answer is 42.\n\n• one"),
      );
    });

    it("keeps letters of any script", () => {
      expect(guestReplyKey("Да, это уже текущая сессия.")).toBe("даэтоужетекущаясессия");
    });
  });

  describe("runGuestPrompt", () => {
    it("starts a new untitled session and remembers its reply", async () => {
      const reply = await runGuestPrompt(CHAT_ID, undefined, "hello");

      expect(reply).toBe("The **answer** is 42.");
      expect(mocked.createMock).toHaveBeenCalledWith({ directory: PROJECT_DIR });
      expect(mocked.registerIgnoreMock).toHaveBeenCalledWith("new-session");
      expect(mocked.promptAsyncMock).toHaveBeenCalledWith({
        sessionID: "new-session",
        directory: PROJECT_DIR,
        parts: [{ type: "text", text: "hello" }],
        agent: "plan",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
      });
      expect(mocked.waitMock).toHaveBeenCalledWith("guest:-100", "new-session", PROJECT_DIR);
      expect(mocked.storedThreads).toEqual([
        expect.objectContaining({
          chatId: CHAT_ID,
          sessionId: "new-session",
          replyKeys: [guestReplyKey(reply)],
        }),
      ]);
    });

    it("continues the given thread, even after the project changed", async () => {
      mocked.storedThreads = [storedThread({ directory: "/other", replyKeys: ["earlier"] })];
      mocked.getCurrentProjectMock.mockReturnValue({ id: "p2", worktree: PROJECT_DIR });

      await runGuestPrompt(CHAT_ID, mocked.storedThreads[0], "follow-up");

      expect(mocked.createMock).not.toHaveBeenCalled();
      expect(mocked.promptAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({ sessionID: "old-session", directory: "/other" }),
      );
      expect(mocked.storedThreads[0]?.replyKeys).toEqual([
        guestReplyKey("The answer is 42."),
        "earlier",
      ]);
    });

    it("starts a new session when the thread's session no longer exists", async () => {
      mocked.getMock.mockResolvedValue({ data: undefined, error: new Error("not found") });

      await runGuestPrompt(CHAT_ID, storedThread(), "hello");

      expect(mocked.promptAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({ sessionID: "new-session" }),
      );
    });

    it("marks the thread running from the moment it is called until it finishes", async () => {
      let finish: (reply: string) => void = () => {};
      mocked.waitMock.mockReturnValue(
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      );
      const thread = storedThread();

      const run = runGuestPrompt(CHAT_ID, thread, "hello");
      expect(isGuestThreadRunning(thread)).toBe(true);

      finish("done");
      await run;
      expect(isGuestThreadRunning(thread)).toBe(false);
    });

    it("fails without a selected project when a new session is needed", async () => {
      mocked.getCurrentProjectMock.mockReturnValue(undefined);

      await expect(runGuestPrompt(CHAT_ID, undefined, "hello")).rejects.toBeInstanceOf(
        GuestNoProjectError,
      );
      expect(mocked.promptAsyncMock).not.toHaveBeenCalled();
    });

    it("surfaces a prompt error without waiting for a reply", async () => {
      const error = new Error("rejected");
      mocked.promptAsyncMock.mockResolvedValue({ data: undefined, error });

      await expect(runGuestPrompt(CHAT_ID, undefined, "hello")).rejects.toBe(error);
      expect(mocked.waitMock).not.toHaveBeenCalled();
    });
  });

  describe("findGuestThread", () => {
    beforeEach(() => {
      mocked.storedThreads = [
        storedThread({
          sessionId: "first",
          replyKeys: [guestReplyKey("Hello. What can I help you with?")],
          updatedAt: "2026-10-01T00:00:00.000Z",
        }),
        storedThread({
          sessionId: "second",
          replyKeys: [guestReplyKey("The available MCP integrations are: Knowledge")],
          updatedAt: "2026-10-02T00:00:00.000Z",
        }),
        storedThread({
          chatId: "-200",
          sessionId: "other-chat",
          updatedAt: "2026-10-03T00:00:00.000Z",
        }),
      ];
    });

    it("starts a new conversation for a message that replies to no bot message", () => {
      expect(findGuestThread(CHAT_ID, undefined)).toBeUndefined();
    });

    it("continues the conversation whose reply is quoted, and remembers the message id", async () => {
      const thread = findGuestThread(CHAT_ID, {
        messageId: 41,
        text: "Hello. What can I help you with?",
      });

      expect(thread?.sessionId).toBe("first");
      await vi.waitFor(() =>
        expect(mocked.storedThreads.find((t) => t.sessionId === "first")?.messageIds).toEqual([41]),
      );

      // Found by id from now on, whatever text the message shows.
      expect(findGuestThread(CHAT_ID, { messageId: 41, text: "⏳ Working… 1m" })?.sessionId).toBe(
        "first",
      );
    });

    it("matches a quoted reply Telegram shortened", () => {
      const thread = findGuestThread(CHAT_ID, {
        messageId: 7,
        text: "The available MCP integrations are:",
      });

      expect(thread?.sessionId).toBe("second");
    });

    it("continues the chat's latest conversation when the reply cannot be placed", () => {
      const thread = findGuestThread(CHAT_ID, { messageId: 9, text: "⏳ Thinking…" });

      expect(thread?.sessionId).toBe("second");
    });
  });
});

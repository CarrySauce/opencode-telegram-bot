import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestThreadInfo } from "../../../src/app/types/settings.js";

const mocked = vi.hoisted(() => ({
  createMock: vi.fn(),
  getMock: vi.fn(),
  messagesMock: vi.fn(),
  statusMock: vi.fn(),
  searchMock: vi.fn(),
  loadAssistantResultMock: vi.fn(),
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
      messages: mocked.messagesMock,
      promptAsync: mocked.promptAsyncMock,
      status: mocked.statusMock,
    },
    experimental: { session: { list: mocked.searchMock } },
  },
}));

vi.mock("../../../src/config.js", () => ({
  config: { bot: { bashToolDisplayMaxLength: 128 } },
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
  loadAssistantResult: mocked.loadAssistantResultMock,
}));

vi.mock("../../../src/app/services/scheduled-task-session-ignore-service.js", () => ({
  registerScheduledTaskSessionIgnore: mocked.registerIgnoreMock,
}));

import {
  __resetGuestSessionsForTests,
  connectGuestThread,
  describeGuestActivity,
  findGuestThread,
  GuestNoProjectError,
  GuestNoReplyError,
  guestReplyKey,
  isGuestThreadRunning,
  runGuestPrompt,
  searchGuestSessions,
  watchGuestSession,
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
      expect(mocked.waitMock).toHaveBeenCalledWith("guest:-100", "new-session", PROJECT_DIR, {
        onInteractiveRequest: expect.any(Function),
      });
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

  describe("describeGuestActivity", () => {
    const SESSION = { sessionId: "session-1", directory: PROJECT_DIR };

    it("describes the latest tool call of the running reply", async () => {
      mocked.messagesMock.mockResolvedValue({
        data: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "check vms" }] },
          {
            info: { id: "m2", role: "assistant" },
            parts: [
              {
                type: "tool",
                tool: "read",
                callID: "c1",
                state: { status: "completed", input: { filePath: "/etc/hosts" }, title: "hosts" },
              },
              {
                type: "tool",
                tool: "bash",
                callID: "c2",
                state: { status: "running", input: { command: "virsh list --all" } },
              },
              { type: "text", text: "Let me check." },
            ],
          },
        ],
        error: undefined,
      });

      const activity = await describeGuestActivity(SESSION);

      expect(mocked.messagesMock).toHaveBeenCalledWith({
        sessionID: "session-1",
        directory: PROJECT_DIR,
      });
      expect(activity).toContain("bash");
      expect(activity).toContain("virsh list --all");
    });

    it("keeps showing the turn's last action once a later step starts writing", async () => {
      mocked.messagesMock.mockResolvedValue({
        data: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "check vms" }] },
          {
            info: { id: "m2", role: "assistant" },
            parts: [
              {
                type: "tool",
                tool: "bash",
                callID: "c1",
                state: { status: "completed", input: { command: "virsh list --all" } },
              },
            ],
          },
          { info: { id: "m3", role: "assistant" }, parts: [{ type: "text", text: "There are" }] },
        ],
        error: undefined,
      });

      await expect(describeGuestActivity(SESSION)).resolves.toContain("virsh list --all");
    });

    it("has nothing to show before the reply makes a tool call", async () => {
      mocked.messagesMock.mockResolvedValue({
        data: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
          { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "Hel" }] },
        ],
        error: undefined,
      });

      await expect(describeGuestActivity(SESSION)).resolves.toBeNull();
    });

    it("does not show a previous turn's action while the new prompt has no reply yet", async () => {
      mocked.messagesMock.mockResolvedValue({
        data: [
          {
            info: { id: "m1", role: "assistant" },
            parts: [
              {
                type: "tool",
                tool: "bash",
                callID: "c1",
                state: { status: "completed", input: { command: "ls" } },
              },
            ],
          },
          { info: { id: "m2", role: "user" }, parts: [{ type: "text", text: "next" }] },
        ],
        error: undefined,
      });

      await expect(describeGuestActivity(SESSION)).resolves.toBeNull();
    });
  });

  describe("searchGuestSessions", () => {
    it("searches root sessions of every project by title, newest first", async () => {
      mocked.searchMock.mockResolvedValue({
        data: [
          { id: "old", title: "vm setup", directory: "/a", time: { updated: 1 } },
          { id: "new", title: "vm check", directory: "/b", time: { updated: 5 } },
        ],
        error: undefined,
      });

      const sessions = await searchGuestSessions("vm");

      expect(mocked.searchMock).toHaveBeenCalledWith({ roots: true, limit: 8, search: "vm" });
      expect(sessions).toEqual([
        { id: "new", title: "vm check", directory: "/b" },
        { id: "old", title: "vm setup", directory: "/a" },
      ]);
    });

    it("lists the latest sessions without a search term", async () => {
      mocked.searchMock.mockResolvedValue({ data: [], error: undefined });

      await searchGuestSessions("");

      expect(mocked.searchMock).toHaveBeenCalledWith({ roots: true, limit: 8 });
    });
  });

  describe("connectGuestThread", () => {
    it("makes the session the chat's latest conversation", async () => {
      mocked.storedThreads = [storedThread({ sessionId: "earlier" })];

      await connectGuestThread(CHAT_ID, { id: "ses-vm", title: "vm", directory: "/infra" });

      // A reply the bot cannot place now continues the connected session.
      expect(findGuestThread(CHAT_ID, { messageId: 1, text: "anything" })?.sessionId).toBe(
        "ses-vm",
      );
      expect(mocked.storedThreads[0]).toEqual(
        expect.objectContaining({ chatId: CHAT_ID, sessionId: "ses-vm", directory: "/infra" }),
      );
    });

    it("keeps what it knew about a session the chat used before", async () => {
      mocked.storedThreads = [storedThread({ sessionId: "ses-vm", replyKeys: ["known"] })];

      const thread = await connectGuestThread(CHAT_ID, {
        id: "ses-vm",
        title: "vm",
        directory: PROJECT_DIR,
      });

      expect(thread.replyKeys).toEqual(["known"]);
    });
  });

  describe("watchGuestSession", () => {
    const thread = storedThread({ sessionId: "ses-vm", directory: "/infra" });

    it("returns the last reply of an idle session", async () => {
      mocked.statusMock.mockResolvedValue({
        data: { "ses-vm": { type: "idle" } },
        error: undefined,
      });
      mocked.loadAssistantResultMock.mockResolvedValue({ resultText: "All VMs run." });
      const ready = vi.fn();

      await expect(watchGuestSession(CHAT_ID, thread, { onSessionReady: ready })).resolves.toBe(
        "All VMs run.",
      );

      expect(ready).toHaveBeenCalledWith({ sessionId: "ses-vm", directory: "/infra" });
      expect(mocked.loadAssistantResultMock).toHaveBeenCalledWith("ses-vm", "/infra");
      expect(mocked.waitMock).not.toHaveBeenCalled();
      expect(mocked.storedThreads[0]?.replyKeys).toEqual([guestReplyKey("All VMs run.")]);
    });

    it("waits for a running session without touching its pending requests", async () => {
      mocked.statusMock.mockResolvedValue({
        data: { "ses-vm": { type: "busy" } },
        error: undefined,
      });
      let finish: (reply: string) => void = () => {};
      mocked.waitMock.mockReturnValue(
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      );

      const watch = watchGuestSession(CHAT_ID, thread);
      expect(isGuestThreadRunning(thread)).toBe(true);
      await vi.waitFor(() => expect(mocked.waitMock).toHaveBeenCalled());
      finish("Done.");

      await expect(watch).resolves.toBe("Done.");
      expect(mocked.waitMock).toHaveBeenCalledWith("guest:-100", "ses-vm", "/infra", {
        onInteractiveRequest: expect.any(Function),
      });
      expect(isGuestThreadRunning(thread)).toBe(false);
    });

    it("fails with no reply when the idle session never answered", async () => {
      mocked.statusMock.mockResolvedValue({ data: {}, error: undefined });
      mocked.loadAssistantResultMock.mockResolvedValue({ resultText: null });

      await expect(watchGuestSession(CHAT_ID, thread)).rejects.toBeInstanceOf(GuestNoReplyError);
    });
  });
});

import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import type { Event } from "@opencode-ai/sdk/v2";
import { setRuntimeMode } from "../../../src/runtime/mode.js";
import { resetSingletonState } from "../../helpers/reset-singleton-state.js";
import { defined } from "../../helpers/defined.js";
import { createTestAppContainer } from "../../helpers/app-container.js";
import type { AppContainer } from "../../../src/app/bootstrap/app-container.js";

const mocked = vi.hoisted(() => ({
  subscribeToEvents: vi.fn(),
  stopEventListening: vi.fn(),
  sendTtsResponseForSession: vi.fn(),
}));

vi.mock("../../../src/bot/handlers/tts-response-handler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/bot/handlers/tts-response-handler.js")>()),
  sendTtsResponseForSession: mocked.sendTtsResponseForSession,
}));

vi.mock("../../../src/opencode/events.js", () => ({
  subscribeToEvents: mocked.subscribeToEvents,
  stopEventListening: mocked.stopEventListening,
}));

type FakeBotApi = {
  sendMessage: ReturnType<typeof vi.fn>;
  sendRichMessage: ReturnType<typeof vi.fn>;
  sendMessageDraft: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  sendDocument: ReturnType<typeof vi.fn>;
};

function createFakeBot(): { bot: Bot<Context>; api: FakeBotApi } {
  const api: FakeBotApi = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
    sendRichMessage: vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Bad Request: rich message unavailable"), { error_code: 400 })),
    sendMessageDraft: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 101 }),
  };

  return { bot: { api } as unknown as Bot<Context>, api };
}

function emitAssistantMessage(
  summaryAggregator: { processEvent(event: Event): void },
  messageId = "message-1",
): void {
  summaryAggregator.processEvent({
    type: "message.updated",
    properties: {
      info: {
        id: messageId,
        sessionID: "session-1",
        role: "assistant",
        time: { created: Date.now() },
      },
    },
  } as unknown as Event);
}

function emitWriteTool(
  summaryAggregator: { processEvent(event: Event): void },
  status: "running" | "completed" = "completed",
  callId = "call-write",
): void {
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: `part-${callId}`,
        sessionID: "session-1",
        messageID: "message-1",
        type: "tool",
        callID: callId,
        tool: "write",
        state: {
          status,
          input: {
            filePath: "src/file.ts",
            content: "const value = 1;\n",
          },
          metadata: {},
        },
      },
    },
  } as unknown as Event);
}

function emitThinkingPart(
  summaryAggregator: { processEvent(event: Event): void },
  text: string,
  messageId = "message-1",
): void {
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: `reasoning-${messageId}`,
        sessionID: "session-1",
        messageID: messageId,
        type: "reasoning",
        text,
      },
    },
  } as unknown as Event);
}

function emitAssistantTextPart(
  summaryAggregator: { processEvent(event: Event): void },
  text: string,
  messageId = "message-1",
): void {
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: `text-${messageId}`,
        sessionID: "session-1",
        messageID: messageId,
        type: "text",
        text,
      },
    },
  } as unknown as Event);
}

function emitAssistantCompleted(
  summaryAggregator: { processEvent(event: Event): void },
  messageId = "message-1",
): void {
  summaryAggregator.processEvent({
    type: "message.updated",
    properties: {
      info: {
        id: messageId,
        sessionID: "session-1",
        role: "assistant",
        agent: "test-agent",
        providerID: "test-provider",
        modelID: "test-model",
        time: { created: Date.now() - 1000, completed: Date.now() },
      },
    },
  } as unknown as Event);
}

function emitSessionIdle(summaryAggregator: { processEvent(event: Event): void }): void {
  summaryAggregator.processEvent({
    type: "session.idle",
    properties: { sessionID: "session-1" },
  } as unknown as Event);
}

function emitPermissionAsked(
  summaryAggregator: { processEvent(event: Event): void },
  requestID: string,
  patterns: string[] = ["D:/shared/*"],
  sessionID = "session-1",
): void {
  summaryAggregator.processEvent({
    type: "permission.asked",
    properties: {
      id: requestID,
      sessionID,
      permission: "external_directory",
      patterns,
      metadata: {},
      always: ["D:/shared/*"],
    },
  } as unknown as Event);
}

function emitBashTool(
  summaryAggregator: { processEvent(event: Event): void },
  status: "running" | "completed" | "error",
  options: { callId?: string; command?: string } = {},
): void {
  const callId = options.callId ?? "call-bash";
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: `part-${callId}`,
        sessionID: "session-1",
        messageID: "message-1",
        type: "tool",
        callID: callId,
        tool: "bash",
        state: {
          status,
          input: { command: options.command ?? "npm test" },
          metadata: {},
          ...(status === "completed" ? { output: "ok" } : {}),
          ...(status === "error" ? { error: "command failed" } : {}),
        },
      },
    },
  } as unknown as Event);
}

function emitReadTool(
  summaryAggregator: { processEvent(event: Event): void },
  status: "running" | "completed" | "error",
  options: { callId: string; filePath: string },
): void {
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: `part-${options.callId}`,
        sessionID: "session-1",
        messageID: "message-1",
        type: "tool",
        callID: options.callId,
        tool: "read",
        state: {
          status,
          input: { filePath: options.filePath },
          metadata: {},
          ...(status === "completed" ? { output: "ok" } : {}),
          ...(status === "error" ? { error: "read failed" } : {}),
        },
      },
    },
  } as unknown as Event);
}

function emitBareTool(
  summaryAggregator: { processEvent(event: Event): void },
  status: "running" | "completed" | "error",
  callId: string,
): void {
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: `part-${callId}`,
        sessionID: "session-1",
        messageID: "message-1",
        type: "tool",
        callID: callId,
        tool: "unknown_tool",
        state: {
          status,
          input: {},
          metadata: {},
          ...(status === "completed" ? { output: "ok" } : {}),
          ...(status === "error" ? { error: "failed" } : {}),
        },
      },
    },
  } as unknown as Event);
}

function emitTaskTool(
  summaryAggregator: { processEvent(event: Event): void },
  options: { callId?: string; status?: "running" | "completed" | "error" } = {},
): void {
  const callId = options.callId ?? "call-task";
  const status = options.status ?? "running";
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: `part-${callId}`,
        sessionID: "session-1",
        messageID: "message-1",
        type: "tool",
        callID: callId,
        tool: "task",
        state: {
          status,
          input: {
            description: "Explore the project",
            subagent_type: "explore",
            prompt: "Inspect architecture",
          },
          metadata: {},
          ...(status === "completed" ? { output: "ok" } : {}),
          ...(status === "error" ? { error: "task failed" } : {}),
        },
      },
    },
  } as unknown as Event);
}

function emitTodoTool(summaryAggregator: { processEvent(event: Event): void }): void {
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "part-call-todo",
        sessionID: "session-1",
        messageID: "message-1",
        type: "tool",
        callID: "call-todo",
        tool: "todowrite",
        state: { status: "running", input: {}, metadata: {} },
      },
    },
  } as unknown as Event);
}

function emitSubagentStart(
  summaryAggregator: { processEvent(event: Event): void },
  suffix = "1",
): void {
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: `subtask-${suffix}`,
        sessionID: "session-1",
        messageID: "message-1",
        type: "subtask",
        prompt: `Inspect the project ${suffix}`,
        description: `inspect task ${suffix}`,
        agent: "explore",
      },
    },
  } as unknown as Event);

  summaryAggregator.processEvent({
    type: "session.created",
    properties: {
      info: {
        id: `child-session-${suffix}`,
        parentID: "session-1",
        title: `inspect task ${suffix} (@explore subagent)`,
        slug: `child-${suffix}`,
        directory: "D:/repo",
        projectID: "p1",
        version: "1",
        time: { created: Date.now(), updated: Date.now() },
      },
    },
  } as unknown as Event);
}

function emitSubagentTool(summaryAggregator: { processEvent(event: Event): void }): void {
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "child-tool-1",
        sessionID: "child-session-1",
        messageID: "child-message-1",
        type: "tool",
        callID: "call-child-bash",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "npm run lint" },
          metadata: {},
        },
      },
    },
  } as unknown as Event);
}

/**
 * Stream flushes start at 1s and can grow during a run. These numbers stay well
 * above the first throttle step so fake-timer helpers do not race the flush.
 *
 * ELAPSED_SETTLE_MS keeps the fake clock inside the same 20-30s display bucket,
 * so the asserted text stays "20s" no matter how long the flush took.
 */
const STREAM_FLUSH_MS = 6000;
const ELAPSED_SETTLE_MS = 29_000;

/**
 * The aggregator dispatches its callbacks through setImmediate, so that one is
 * deliberately left real - only the clock and the timers the tracker and the
 * streamers rely on are faked.
 */
function useTrackerFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

/**
 * Lets the aggregator's setImmediate dispatch run and then flushes the faked
 * streamer timers it scheduled.
 */
async function flushPendingDispatch(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(STREAM_FLUSH_MS);
  }
}

function collectSentTexts(api: FakeBotApi): string[] {
  return [
    ...api.sendMessage.mock.calls.map((call) => String(call[1])),
    ...api.editMessageText.mock.calls.map((call) => String(call[2])),
  ];
}

function emitPermissionReplied(
  summaryAggregator: { processEvent(event: Event): void },
  requestID: string,
): void {
  summaryAggregator.processEvent({
    type: "permission.replied",
    properties: {
      sessionID: "session-1",
      requestID,
      reply: "always",
    },
  } as unknown as Event);
}

function emitQuestionAsked(
  summaryAggregator: { processEvent(event: Event): void },
  requestID: string,
): void {
  summaryAggregator.processEvent({
    type: "question.asked",
    properties: {
      id: requestID,
      sessionID: "session-1",
      questions: [
        {
          header: "Pick",
          question: `Which option for ${requestID}?`,
          options: [{ label: "A", description: "first" }],
        },
      ],
    },
  } as unknown as Event);
}

describe("bot/services/event-subscription-service", () => {
  let tempHome: string;
  let activeService: {
    cleanup(reason: string): void;
    stopBackgroundOperations(reason: string, sessionId?: string): void;
  } | null = null;
  let activeContainer: AppContainer;

  beforeEach(async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-telegram-token");
    vi.stubEnv("TELEGRAM_ALLOWED_USER_ID", "123456789");
    vi.stubEnv("OPENCODE_MODEL_PROVIDER", "test-provider");
    vi.stubEnv("OPENCODE_MODEL_ID", "test-model");
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", await mkdtemp(path.join(os.tmpdir(), "event-service-")));
    tempHome = process.env.OPENCODE_TELEGRAM_HOME!;
    setRuntimeMode("installed");

    mocked.subscribeToEvents.mockReset();
    mocked.stopEventListening.mockReset();
    mocked.subscribeToEvents.mockResolvedValue(undefined);
    mocked.sendTtsResponseForSession.mockReset();
    mocked.sendTtsResponseForSession.mockResolvedValue(false);

    const settingsStore = await import("../../../src/app/stores/settings-store.js");
    settingsStore.__resetSettingsForTests();
    await resetSingletonState();
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Settings writes scheduled while timers were faked need a real tick to
    // land before the temp home is removed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeService?.cleanup("test_cleanup");
    activeService = null;

    const settingsStore = await import("../../../src/app/stores/settings-store.js");
    settingsStore.__resetSettingsForTests();
    vi.unstubAllEnvs();
    // Settings writes can still be landing on Windows when the temp home is
    // removed, so retry instead of failing the test in teardown.
    await rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function setupService(
    sendDiffFileAttachments: boolean,
    options: {
      responseStreamingMode?: "edit" | "draft";
      showThinkingContent?: boolean;
      showAssistantRunFooter?: boolean;
      startAssistantRun?: boolean;
    } = {},
  ): Promise<{
    api: FakeBotApi;
    summaryAggregator: { setSession(sessionId: string): void; processEvent(event: Event): void };
  }> {
    const [
      { createEventSubscriptionService },
      sessionService,
      settingsStore,
    ] = await Promise.all([
        import("../../../src/bot/services/event-subscription-service.js"),
        import("../../../src/app/services/session-service.js"),
        import("../../../src/app/stores/settings-store.js"),
      ]);

    sessionService.setCurrentSession({
      id: "session-1",
      title: "Test session",
      directory: "D:/repo",
    });
    settingsStore.setCompactOutputMode(false);
    settingsStore.setSendDiffFileAttachments(sendDiffFileAttachments);
    settingsStore.setResponseStreamingMode(options.responseStreamingMode ?? "edit");
    settingsStore.setShowThinkingContent(options.showThinkingContent ?? true);
    settingsStore.setShowAssistantRunFooter(options.showAssistantRunFooter ?? true);

    const { bot, api } = createFakeBot();
    activeContainer = createTestAppContainer();
    const { summaryAggregator, assistantRunState } = activeContainer;
    const service = createEventSubscriptionService(activeContainer);
    activeService = service;
    service.clearRuntimeState("test_setup");
    if (options.startAssistantRun) {
      assistantRunState.startRun("session-1", {
        startedAt: Date.now() - 1000,
        configuredAgent: "test-agent",
        configuredProviderID: "test-provider",
        configuredModelID: "test-model",
      });
    }
    service.setTelegramContext(bot, 42);
    await service.ensureEventSubscription("D:/repo");
    summaryAggregator.setSession("session-1");
    emitAssistantMessage(summaryAggregator);

    return { api, summaryAggregator };
  }

  it("sends write tool output as a document attachment when diff files are enabled", async () => {
    const { api, summaryAggregator } = await setupService(true);

    emitWriteTool(summaryAggregator);

    await vi.waitFor(() => {
      expect(api.sendDocument).toHaveBeenCalledTimes(1);
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("streams write tool call text without document attachment when diff files are disabled", async () => {
    const { api, summaryAggregator } = await setupService(false);

    emitWriteTool(summaryAggregator);
    emitSessionIdle(summaryAggregator);

    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );
    expect(defined(api.sendMessage.mock.calls[0]?.[1])).toContain("write");
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  describe("elapsed time for long tool calls", () => {
    it("shows a full-mode running line before the timer starts", async () => {
      const { api, summaryAggregator } = await setupService(false);
      useTrackerFakeTimers();

      emitBashTool(summaryAggregator, "running", { command: "sleep 60" });
      await vi.advanceTimersByTimeAsync(1500);

      expect(collectSentTexts(api)).toEqual(expect.arrayContaining([expect.stringContaining("⏳ 💻 bash sleep 60")]));
      expect(collectSentTexts(api).some((text) => text.includes("🕒"))).toBe(false);

      await vi.advanceTimersByTimeAsync(25_000);
      expect(collectSentTexts(api).some((text) => text.includes("⏳") && text.includes("🕒 20s"))).toBe(true);
    });

    it("replaces parallel lines in start order even when they finish in reverse order", async () => {
      const { api, summaryAggregator } = await setupService(false);
      useTrackerFakeTimers();

      emitBashTool(summaryAggregator, "running", { command: "sleep 60" });
      emitReadTool(summaryAggregator, "running", { callId: "call-read", filePath: "README.md" });
      await vi.advanceTimersByTimeAsync(3000);
      emitReadTool(summaryAggregator, "completed", { callId: "call-read", filePath: "README.md" });
      await flushPendingDispatch();

      const intermediate = collectSentTexts(api).pop() ?? "";
      expect(intermediate.indexOf("sleep 60")).toBeLessThan(intermediate.indexOf("README.md"));
      expect(intermediate).toContain("⏳ 💻 bash");
      expect(intermediate).toContain("📖 read");

      emitBashTool(summaryAggregator, "completed", { command: "sleep 60" });
      await flushPendingDispatch();
      const final = collectSentTexts(api).pop() ?? "";
      expect(final.indexOf("sleep 60")).toBeLessThan(final.indexOf("README.md"));
      expect(final).not.toContain("⏳");
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("starts a todo stream after an earlier ordinary tool stream", async () => {
      const { api, summaryAggregator } = await setupService(false);
      useTrackerFakeTimers();

      emitBashTool(summaryAggregator, "running", { command: "sleep 60" });
      emitTodoTool(summaryAggregator);
      await vi.advanceTimersByTimeAsync(5000);

      expect(String(api.sendMessage.mock.calls[0]?.[1])).toContain("sleep 60");
      expect(String(api.sendMessage.mock.calls[1]?.[1])).toContain("todowrite");
    });

    it("flushes a running tool line above its permission prompt", async () => {
      const { api, summaryAggregator } = await setupService(false);
      useTrackerFakeTimers();

      emitBashTool(summaryAggregator, "running", { command: "sleep 60" });
      emitPermissionAsked(summaryAggregator, "perm-1");
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));

      expect(String(api.sendMessage.mock.calls[0]?.[1])).toContain("⏳ 💻 bash sleep 60");
      expect(String(api.sendMessage.mock.calls[1]?.[1])).toContain("D:/shared/*");
    });

    it("removes an attached tool line without losing a parallel running sibling", async () => {
      const { api, summaryAggregator } = await setupService(true);
      useTrackerFakeTimers();

      emitWriteTool(summaryAggregator, "running");
      emitBashTool(summaryAggregator, "running", { command: "sleep 60" });
      await vi.advanceTimersByTimeAsync(3000);
      emitWriteTool(summaryAggregator, "completed");
      await flushPendingDispatch();

      await vi.waitFor(() => expect(api.sendDocument).toHaveBeenCalledTimes(1));
      const afterDocument = collectSentTexts(api).pop() ?? "";
      expect(afterDocument).toContain("sleep 60");
      expect(afterDocument).not.toContain("write");
      await vi.advanceTimersByTimeAsync(25_000);
      expect(collectSentTexts(api).pop()).toMatch(/sleep 60 · 🕒 \d+s/);
    });

    it("deletes an attachment-only running message when the document arrives", async () => {
      const { api, summaryAggregator } = await setupService(true);
      useTrackerFakeTimers();

      emitWriteTool(summaryAggregator, "running");
      await vi.advanceTimersByTimeAsync(3000);
      emitWriteTool(summaryAggregator, "completed");
      await flushPendingDispatch();

      expect(api.deleteMessage).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(api.sendDocument).toHaveBeenCalledTimes(1));
    });

    it("holds calls started during document delivery below the document while editing older siblings", async () => {
      const { api, summaryAggregator } = await setupService(true);
      useTrackerFakeTimers();
      let deliverDocument: (() => void) | undefined;
      api.sendDocument.mockImplementation(
        () => new Promise((resolve) => {
          deliverDocument = () => resolve({ message_id: 101 });
        }),
      );

      emitBashTool(summaryAggregator, "running", { command: "sleep 60" });
      emitWriteTool(summaryAggregator, "running");
      await vi.advanceTimersByTimeAsync(4000);
      emitWriteTool(summaryAggregator, "completed");
      await vi.waitFor(() => expect(api.sendDocument).toHaveBeenCalledTimes(1));

      emitReadTool(summaryAggregator, "running", { callId: "call-later", filePath: "LATER.md" });
      await vi.advanceTimersByTimeAsync(22_000);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(collectSentTexts(api).pop()).toContain("sleep 60 · 🕒");

      expect(deliverDocument).toBeTypeOf("function");
      deliverDocument?.();
      const runtime = activeService as unknown as { runtime: { toolMessageBatcher: { flushSession(sessionId: string, reason: string): Promise<void> } } };
      await runtime.runtime.toolMessageBatcher.flushSession("session-1", "test_document_complete");
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(12_000);
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
      expect(String(api.sendMessage.mock.calls[1]?.[1])).toContain("LATER.md");
    });

    it("holds later tool lines until both parallel attachment uploads finish", async () => {
      const { api, summaryAggregator } = await setupService(true);
      useTrackerFakeTimers();
      const releases: Array<() => void> = [];
      api.sendDocument.mockImplementation(() => new Promise((resolve) => {
        releases.push(() => resolve({ message_id: 101 }));
      }));

      emitWriteTool(summaryAggregator, "running", "write-one");
      emitWriteTool(summaryAggregator, "running", "write-two");
      await vi.advanceTimersByTimeAsync(3000);
      emitWriteTool(summaryAggregator, "completed", "write-one");
      emitWriteTool(summaryAggregator, "completed", "write-two");
      await vi.waitFor(() => expect(api.sendDocument).toHaveBeenCalledTimes(1));
      emitReadTool(summaryAggregator, "running", { callId: "call-later", filePath: "LATER.md" });

      releases[0]?.();
      await vi.waitFor(() => expect(api.sendDocument).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(5000);
      expect(collectSentTexts(api).some((text) => text.includes("LATER.md"))).toBe(false);

      releases[1]?.();
      const runtime = activeService as unknown as { runtime: { toolMessageBatcher: { flushSession(sessionId: string, reason: string): Promise<void> } } };
      await runtime.runtime.toolMessageBatcher.flushSession("session-1", "test_documents_complete");
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(12_000);
      await vi.waitFor(() => expect(collectSentTexts(api).some((text) => text.includes("LATER.md"))).toBe(true));
    });

    it("shows a live line once the call passes the threshold", async () => {
      const { api, summaryAggregator } = await setupService(false);

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running");
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);

      const texts = collectSentTexts(api);
      expect(texts.some((text) => text.includes("⏳") && text.includes("· 🕒 20s"))).toBe(true);
      expect(texts.some((text) => text.includes("npm test"))).toBe(true);
    });

    it("replaces the live line with a final line carrying the total duration", async () => {
      const { api, summaryAggregator } = await setupService(false);

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running");
      await vi.advanceTimersByTimeAsync(25_000);
      emitBashTool(summaryAggregator, "completed");
      await flushPendingDispatch();

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("npm test");
      expect(lastText).toContain("· 🕒 25s");
      expect(lastText).not.toContain("⏳");
    });

    it("leaves fast tool calls exactly as before", async () => {
      const { api, summaryAggregator } = await setupService(false);

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running");
      await vi.advanceTimersByTimeAsync(200);
      emitBashTool(summaryAggregator, "completed");
      await flushPendingDispatch();

      const texts = collectSentTexts(api);
      expect(texts.some((text) => text.includes("npm test"))).toBe(true);
      expect(texts.some((text) => text.includes("⏳"))).toBe(false);
      expect(texts.some((text) => text.includes("🕒"))).toBe(false);
    });

    it("does not send compact progress after the session goes idle", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running");
      emitSessionIdle(summaryAggregator);
      await flushPendingDispatch();

      expect(collectSentTexts(api).some((text) => text.includes("⏳ Working"))).toBe(false);
    });

    it("adds the duration to the compact progress line", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      // Let the settings write finish before the clock is faked, otherwise it
      // races with the temp home cleanup in afterEach.
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running");
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);

      const texts = collectSentTexts(api);
      expect(texts.some((text) => text.includes("· 🕒 20s"))).toBe(true);
    });

    it("stops the timer when a tool call ends in an error", async () => {
      const { api, summaryAggregator } = await setupService(false);

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running");
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);
      emitBashTool(summaryAggregator, "error");
      await flushPendingDispatch();

      const callsAfterError = collectSentTexts(api).length;
      await vi.advanceTimersByTimeAsync(120_000);

      expect(collectSentTexts(api)).toHaveLength(callsAfterError);
    });

    it("leaves a failed tool call without the running marker but with its duration", async () => {
      const { api, summaryAggregator } = await setupService(false);

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running");
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);
      emitBashTool(summaryAggregator, "error");
      await flushPendingDispatch();

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("npm test");
      // The final line carries the exact duration, not the display bucket.
      expect(lastText).toContain("· 🕒 29s");
      expect(lastText).not.toContain("⏳");
    });

    it("stops tracking a session that goes idle after it stopped being current", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const sessionService = await import("../../../src/app/services/session-service.js");

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running");
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);
      const callsBefore = collectSentTexts(api).length;

      sessionService.setCurrentSession({
        id: "session-2",
        title: "Other session",
        directory: "D:/repo",
      });
      emitSessionIdle(summaryAggregator);
      await flushPendingDispatch();

      // Coming back makes the tick pass its current-session check again, so a
      // tracker entry that survived the idle would resume editing the message.
      sessionService.setCurrentSession({
        id: "session-1",
        title: "Test session",
        directory: "D:/repo",
      });
      await vi.advanceTimersByTimeAsync(120_000);

      expect(collectSentTexts(api)).toHaveLength(callsBefore);
    });

    it("times the task tool in compact mode, where no subagent card exists", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitTaskTool(summaryAggregator);
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);

      const texts = collectSentTexts(api);
      expect(texts.some((text) => text.includes("Running Task") && text.includes("· 🕒 20s"))).toBe(
        true,
      );
    });

    it("falls back to the still-running bash after parallel reads finish in compact mode", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running", { command: "sleep 90" });
      emitReadTool(summaryAggregator, "running", { callId: "call-read-1", filePath: "README.md" });
      emitReadTool(summaryAggregator, "completed", { callId: "call-read-1", filePath: "README.md" });
      emitReadTool(summaryAggregator, "running", { callId: "call-read-2", filePath: "AGENTS.md" });
      emitReadTool(summaryAggregator, "completed", { callId: "call-read-2", filePath: "AGENTS.md" });
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("sleep 90");
      expect(lastText).toContain("· 🕒 20s");
      expect(lastText).not.toContain("AGENTS.md");
      expect(lastText).not.toContain("README.md");
    });

    it("lets a new compact tool take the line and returns to the remaining one with its timer", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running", { command: "sleep 90" });
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);
      emitReadTool(summaryAggregator, "running", { callId: "call-read-1", filePath: "AGENTS.md" });
      await flushPendingDispatch();

      expect(collectSentTexts(api).pop() ?? "").toContain("AGENTS.md");

      emitReadTool(summaryAggregator, "completed", { callId: "call-read-1", filePath: "AGENTS.md" });
      await flushPendingDispatch();

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("sleep 90");
      expect(lastText).toMatch(/· 🕒 \d+[ms]/);
      expect(lastText).not.toContain("AGENTS.md");
    });

    it("shows the most recently started still-running tool in compact mode", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running", { command: "sleep 90" });
      await flushPendingDispatch();
      emitReadTool(summaryAggregator, "running", { callId: "call-read-1", filePath: "AGENTS.md" });
      await flushPendingDispatch();

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("AGENTS.md");
      expect(lastText).not.toContain("sleep 90");
    });

    it("leaves the finished tool on the compact line once nothing is still running", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running", { command: "sleep 90" });
      emitReadTool(summaryAggregator, "running", { callId: "call-read-1", filePath: "AGENTS.md" });
      emitReadTool(summaryAggregator, "completed", { callId: "call-read-1", filePath: "AGENTS.md" });
      emitBashTool(summaryAggregator, "completed", { command: "sleep 90" });
      await flushPendingDispatch();

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("sleep 90");
      expect(lastText).not.toContain("🕒");
    });

    it("treats an error sibling like a finish and falls back to the still-running tool", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running", { command: "sleep 90" });
      emitReadTool(summaryAggregator, "running", { callId: "call-read-1", filePath: "AGENTS.md" });
      emitReadTool(summaryAggregator, "error", { callId: "call-read-1", filePath: "AGENTS.md" });
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("sleep 90");
      expect(lastText).toContain("· 🕒 20s");
      expect(lastText).not.toContain("AGENTS.md");
    });

    it("applies the same compact fallback when a task tool runs beside bash", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running", { command: "sleep 90" });
      emitTaskTool(summaryAggregator);
      await flushPendingDispatch();
      expect(collectSentTexts(api).pop() ?? "").toContain("Running Task");

      emitTaskTool(summaryAggregator, { status: "completed" });
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("sleep 90");
      expect(lastText).toMatch(/· 🕒 \d+[ms]/);
    });

    it("keeps the running compact tool on the line when thinking or writing arrives", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running", { command: "sleep 90" });
      await flushPendingDispatch();
      emitThinkingPart(summaryAggregator, "planning");
      await flushPendingDispatch();
      emitAssistantTextPart(summaryAggregator, "Here is the answer");
      await flushPendingDispatch();

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("sleep 90");
      expect(lastText).not.toContain("Thinking");
      expect(lastText).not.toContain("Writing answer");
    });

    it("shows a detail-less running sibling instead of a finished compact tool", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running", { command: "sleep 90" });
      emitReadTool(summaryAggregator, "running", { callId: "call-read-1", filePath: "AGENTS.md" });
      emitBareTool(summaryAggregator, "running", "call-bare");
      emitReadTool(summaryAggregator, "completed", { callId: "call-read-1", filePath: "AGENTS.md" });
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("unknown_tool");
      expect(lastText).toContain("· 🕒 20s");
      expect(lastText).not.toContain("AGENTS.md");
    });

    it("does not leave a finished compact tool on the line when only a detail-less sibling remains", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitReadTool(summaryAggregator, "running", { callId: "call-read-1", filePath: "AGENTS.md" });
      emitBareTool(summaryAggregator, "running", "call-bare");
      emitReadTool(summaryAggregator, "completed", { callId: "call-read-1", filePath: "AGENTS.md" });
      await vi.advanceTimersByTimeAsync(ELAPSED_SETTLE_MS);

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).not.toContain("AGENTS.md");
      expect(lastText).toContain("unknown_tool");
      expect(lastText).toContain("· 🕒 20s");
    });

    it("does not let an older compact tool steal the line on a later running update", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running", { command: "sleep 90" });
      await flushPendingDispatch();
      emitReadTool(summaryAggregator, "running", { callId: "call-read-1", filePath: "AGENTS.md" });
      await flushPendingDispatch();
      emitBashTool(summaryAggregator, "running", { command: "sleep 90" });
      await flushPendingDispatch();

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("AGENTS.md");
      expect(lastText).not.toContain("sleep 90");
    });

    it("shows the existing duration bucket when falling back after ten minutes", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitBashTool(summaryAggregator, "running", { command: "sleep 90" });
      await vi.advanceTimersByTimeAsync(12 * 60_000);
      emitReadTool(summaryAggregator, "running", { callId: "call-read-1", filePath: "AGENTS.md" });
      emitReadTool(summaryAggregator, "completed", { callId: "call-read-1", filePath: "AGENTS.md" });
      await flushPendingDispatch();

      const lastText = collectSentTexts(api).pop() ?? "";
      expect(lastText).toContain("sleep 90");
      expect(lastText).toContain("· 🕒 10m");
      expect(lastText).not.toContain("12m");
      expect(lastText).not.toContain("AGENTS.md");
    });

    it("keeps subagent cards ticking without any incoming events", async () => {
      const { api, summaryAggregator } = await setupService(false);

      useTrackerFakeTimers();
      emitSubagentStart(summaryAggregator);
      emitSubagentTool(summaryAggregator);
      await flushPendingDispatch();
      await vi.advanceTimersByTimeAsync(25_000);

      const texts = collectSentTexts(api);
      expect(texts.some((text) => text.includes("npm run lint") && /· 🕒 \d+s/.test(text))).toBe(
        true,
      );
    });

    it("sends overlapping subagents as independent card messages", async () => {
      const { api, summaryAggregator } = await setupService(false);

      useTrackerFakeTimers();
      emitSubagentStart(summaryAggregator, "1");
      emitSubagentStart(summaryAggregator, "2");
      await flushPendingDispatch();

      const cardMessages = api.sendMessage.mock.calls
        .map((call) => String(call[1]))
        .filter((text) => text.includes("🧩"));

      expect(cardMessages).toEqual(
        expect.arrayContaining([
          expect.stringContaining("inspect task 1"),
          expect.stringContaining("inspect task 2"),
        ]),
      );
      expect(cardMessages.every((text) => !(text.includes("inspect task 1") && text.includes("inspect task 2")))).toBe(
        true,
      );
    });
  });

  describe("compact progress at the start of work", () => {
    it("shows thinking on the progress message before any tool runs", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitThinkingPart(summaryAggregator, "planning");
      await flushPendingDispatch();

      const texts = collectSentTexts(api);
      expect(texts.some((text) => text.includes("💭 Thinking..."))).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("shows writing on the progress message when the model writes first", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitAssistantTextPart(summaryAggregator, "Here is the answer");
      await flushPendingDispatch();

      expect(collectSentTexts(api).some((text) => text.includes("✍️ Writing answer..."))).toBe(true);
    });

    it("reuses the thinking message for a later tool and then writing", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitThinkingPart(summaryAggregator, "planning");
      await flushPendingDispatch();
      emitBashTool(summaryAggregator, "running");
      await flushPendingDispatch();
      emitAssistantTextPart(summaryAggregator, "not yet");
      await flushPendingDispatch();

      expect(collectSentTexts(api).some((text) => text.includes("✍️ Writing answer..."))).toBe(false);
      expect(collectSentTexts(api).pop() ?? "").toContain("npm test");

      emitBashTool(summaryAggregator, "completed");
      await flushPendingDispatch();
      emitAssistantTextPart(summaryAggregator, "Here is the answer");
      await flushPendingDispatch();

      const progressSends = api.sendMessage.mock.calls.filter((call) =>
        String(call[1]).includes("⏳ Working"),
      );
      expect(progressSends).toHaveLength(1);
      expect(collectSentTexts(api).some((text) => text.includes("✍️ Writing answer..."))).toBe(true);
    });

    it("deletes the progress message on idle when delete on finish is on", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      settingsStore.setDeleteCompactProgressOnFinish(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitThinkingPart(summaryAggregator, "planning");
      await flushPendingDispatch();
      emitSessionIdle(summaryAggregator);
      await flushPendingDispatch();

      expect(api.deleteMessage).toHaveBeenCalled();
    });

    it("finalizes a second run while the first card is still being finalized", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      let nextMessageId = 100;
      api.sendMessage.mockImplementation(async () => ({ message_id: nextMessageId++ }));

      let releaseFirstEdit: (() => void) | undefined;
      api.editMessageText.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirstEdit = () => resolve(undefined);
          }),
      );

      useTrackerFakeTimers();
      emitThinkingPart(summaryAggregator, "run-a");
      await flushPendingDispatch();
      emitSessionIdle(summaryAggregator);
      await flushPendingDispatch();

      emitAssistantMessage(summaryAggregator, "message-2");
      emitThinkingPart(summaryAggregator, "run-b", "message-2");
      await flushPendingDispatch();
      emitSessionIdle(summaryAggregator);
      await flushPendingDispatch();

      expect(api.editMessageText).toHaveBeenCalledTimes(2);
      expect(
        api.editMessageText.mock.calls.every((call) => String(call[2]).includes("✅ Finished Work")),
      ).toBe(true);

      releaseFirstEdit?.();
    });

    it("closes the card when a reply is delivered and opens a new one for the next stretch", async () => {
      const { api, summaryAggregator } = await setupService(false, { startAssistantRun: true });
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitThinkingPart(summaryAggregator, "planning");
      await flushPendingDispatch();
      emitBashTool(summaryAggregator, "completed", { callId: "call-1" });
      await flushPendingDispatch();
      emitAssistantTextPart(summaryAggregator, "First reply");
      emitAssistantCompleted(summaryAggregator, "message-1");
      await flushPendingDispatch();

      const finishedEdits = api.editMessageText.mock.calls.filter((call) =>
        String(call[2]).includes("✅ Finished Work"),
      );
      expect(finishedEdits).toHaveLength(1);
      expect(String(finishedEdits[0]?.[2])).toContain("tool calls: 1");

      emitThinkingPart(summaryAggregator, "again", "message-2");
      await flushPendingDispatch();
      emitBashTool(summaryAggregator, "completed", { callId: "call-2" });
      await flushPendingDispatch();
      emitAssistantMessage(summaryAggregator, "message-2");
      emitAssistantTextPart(summaryAggregator, "Second reply", "message-2");
      emitAssistantCompleted(summaryAggregator, "message-2");
      await flushPendingDispatch();

      const workingSends = api.sendMessage.mock.calls.filter((call) =>
        String(call[1]).includes("⏳ Working"),
      );
      expect(workingSends.length).toBeGreaterThanOrEqual(2);
      const laterFinished = api.editMessageText.mock.calls.filter((call) =>
        String(call[2]).includes("✅ Finished Work"),
      );
      expect(laterFinished).toHaveLength(2);
      expect(String(laterFinished[1]?.[2])).toContain("tool calls: 1");
      expect(String(laterFinished[1]?.[2])).not.toContain("tool calls: 2");

      emitSessionIdle(summaryAggregator);
      await flushPendingDispatch();

      const footerSends = api.sendMessage.mock.calls.filter((call) =>
        String(call[1]).includes("test-provider/test-model"),
      );
      expect(footerSends).toHaveLength(1);
      expect(laterFinished).toHaveLength(2);
    });

    it("does not edit the open card with activity that arrives before the reply close runs", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitThinkingPart(summaryAggregator, "planning");
      await flushPendingDispatch();
      const progressMessageId = api.sendMessage.mock.calls.find((call) =>
        String(call[1]).includes("⏳ Working"),
      )?.[0];

      emitAssistantTextPart(summaryAggregator, "First reply");
      emitAssistantCompleted(summaryAggregator);
      emitBashTool(summaryAggregator, "running", {
        callId: "call-next",
        command: "echo next-stretch",
      });
      await flushPendingDispatch();

      expect(
        api.editMessageText.mock.calls.some((call) => String(call[2]).includes("echo next-stretch")),
      ).toBe(false);
      expect(
        api.sendMessage.mock.calls.some((call) => String(call[1]).includes("echo next-stretch")),
      ).toBe(true);
      expect(
        api.editMessageText.mock.calls.some((call) => String(call[2]).includes("✅ Finished Work")),
      ).toBe(true);
      expect(progressMessageId).toBeDefined();
    });

    it("does not send a second copy of a reply after compact delivery", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitThinkingPart(summaryAggregator, "planning");
      await flushPendingDispatch();
      emitAssistantTextPart(summaryAggregator, "A long answer about tea");
      emitAssistantCompleted(summaryAggregator);
      emitAssistantTextPart(summaryAggregator, "A long answer about tea with a late tail");
      await flushPendingDispatch();

      const replySends = api.sendMessage.mock.calls.filter((call) =>
        String(call[1]).includes("long answer about tea"),
      );
      expect(replySends).toHaveLength(1);
    });

    it("removes the mid-run card when delete on finish is on", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      settingsStore.setDeleteCompactProgressOnFinish(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitThinkingPart(summaryAggregator, "planning");
      await flushPendingDispatch();
      emitAssistantTextPart(summaryAggregator, "Done");
      emitAssistantCompleted(summaryAggregator);
      await flushPendingDispatch();

      expect(api.deleteMessage).toHaveBeenCalled();
      expect(
        api.editMessageText.mock.calls.some((call) => String(call[2]).includes("✅ Finished Work")),
      ).toBe(false);

      emitThinkingPart(summaryAggregator, "again", "message-2");
      await flushPendingDispatch();
      const workingSends = api.sendMessage.mock.calls.filter((call) =>
        String(call[1]).includes("⏳ Working"),
      );
      expect(workingSends.length).toBeGreaterThanOrEqual(2);
    });

    it("leaves the card live when the question prompt fails to send", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitThinkingPart(summaryAggregator, "planning");
      await flushPendingDispatch();

      api.sendMessage.mockImplementation(async (chatId: number, text: string) => {
        if (String(text).includes("Which option")) {
          throw new Error("send failed");
        }
        return { message_id: 700 + chatId };
      });

      emitQuestionAsked(summaryAggregator, "q-fail");
      await flushPendingDispatch();

      expect(
        api.editMessageText.mock.calls.some((call) => String(call[2]).includes("✅ Finished Work")),
      ).toBe(false);
      expect(api.deleteMessage).not.toHaveBeenCalled();
    });

    it("edits the progress message to the finished summary on idle when delete on finish is off", async () => {
      const { api, summaryAggregator } = await setupService(false);
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      useTrackerFakeTimers();
      emitThinkingPart(summaryAggregator, "planning");
      await flushPendingDispatch();
      emitSessionIdle(summaryAggregator);
      await flushPendingDispatch();

      expect(collectSentTexts(api).some((text) => text.includes("✅ Finished Work"))).toBe(true);
    });
  });

  describe("background operations", () => {
    function emitBackgroundBash(
      summaryAggregator: { processEvent(event: Event): void },
      status: "running" | "completed",
    ): void {
      summaryAggregator.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-call-bg",
            sessionID: "session-1",
            messageID: "message-1",
            type: "tool",
            callID: "call-bg",
            tool: "bash",
            state: {
              status,
              input: { command: "sleep 90", background: true },
              metadata: {},
              ...(status === "completed" ? { output: "ok" } : {}),
            },
          },
        },
      } as unknown as Event);
    }

    /** Launches a background command, then replies and ends the turn. */
    async function launchAndEndTurn(
      api: FakeBotApi,
      summaryAggregator: { processEvent(event: Event): void },
    ): Promise<number> {
      let nextMessageId = 100;
      api.sendMessage.mockImplementation(async () => ({ message_id: nextMessageId++ }));

      useTrackerFakeTimers();
      emitBackgroundBash(summaryAggregator, "running");
      await flushPendingDispatch();
      const lineMessageId = nextMessageId - 1;
      emitAssistantTextPart(summaryAggregator, "started");
      emitAssistantCompleted(summaryAggregator);
      await flushPendingDispatch();
      emitSessionIdle(summaryAggregator);
      await flushPendingDispatch();
      return lineMessageId;
    }

    async function useCompactMode(): Promise<void> {
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    it("keeps counting a background command after the turn and finishes its line in place", async () => {
      const { api, summaryAggregator } = await setupService(false, { startAssistantRun: true });
      const lineMessageId = await launchAndEndTurn(api, summaryAggregator);

      await vi.advanceTimersByTimeAsync(30_000);
      const running = api.editMessageText.mock.calls.filter((call) => call[1] === lineMessageId);
      expect(String(running.at(-1)?.[2])).toMatch(/⏳ .*sleep 90 · 🕒 \d+[ms]/);

      emitBackgroundBash(summaryAggregator, "completed");
      await flushPendingDispatch();

      const finished = api.editMessageText.mock.calls.filter((call) => call[1] === lineMessageId);
      const finalLine = String(finished.at(-1)?.[2]);
      expect(finalLine).toContain("sleep 90");
      expect(finalLine).toMatch(/· 🕒 \d+[ms]/);
      expect(finalLine).not.toContain("⏳");
    });

    it("leaves the line as it was when background operations are stopped", async () => {
      const { api, summaryAggregator } = await setupService(false, { startAssistantRun: true });
      await launchAndEndTurn(api, summaryAggregator);
      await vi.advanceTimersByTimeAsync(25_000);

      activeService?.stopBackgroundOperations("test", "session-1");
      await flushPendingDispatch();
      const textsBefore = collectSentTexts(api).length;
      await vi.advanceTimersByTimeAsync(60_000);
      emitBackgroundBash(summaryAggregator, "completed");
      await flushPendingDispatch();

      expect(collectSentTexts(api).slice(textsBefore)).toEqual([]);
    });

    it("keeps a background subagent's card live after the turn and completes it in place", async () => {
      const { api, summaryAggregator } = await setupService(false, { startAssistantRun: true });
      let nextMessageId = 100;
      api.sendMessage.mockImplementation(async () => ({ message_id: nextMessageId++ }));

      useTrackerFakeTimers();
      emitSubagentStart(summaryAggregator);
      summaryAggregator.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-call-task",
            sessionID: "session-1",
            messageID: "message-1",
            type: "tool",
            callID: "call-task",
            tool: "task",
            state: {
              status: "running",
              input: { description: "inspect task 1", background: true },
              metadata: { sessionId: "child-session-1" },
            },
          },
        },
      } as unknown as Event);
      await flushPendingDispatch();
      const cardMessageId = nextMessageId - 1;
      emitAssistantTextPart(summaryAggregator, "launched");
      emitAssistantCompleted(summaryAggregator);
      emitSessionIdle(summaryAggregator);
      await flushPendingDispatch();

      emitSubagentTool(summaryAggregator);
      await vi.advanceTimersByTimeAsync(25_000);
      const cardEdits = () =>
        api.editMessageText.mock.calls
          .filter((call) => call[1] === cardMessageId)
          .map((call) => String(call[2]));
      expect(cardEdits().at(-1)).toMatch(/npm run lint · 🕒 \d+s/);

      summaryAggregator.processEvent({
        type: "session.idle",
        properties: { sessionID: "child-session-1" },
      } as unknown as Event);
      await flushPendingDispatch();
      expect(cardEdits().at(-1)).toMatch(/✅ Completed · 🕒/);
    });

    it("stops a background command once its session is no longer current", async () => {
      const { api, summaryAggregator } = await setupService(false, { startAssistantRun: true });
      const sessionService = await import("../../../src/app/services/session-service.js");
      await launchAndEndTurn(api, summaryAggregator);

      sessionService.setCurrentSession({ id: "session-2", title: "Other", directory: "D:/repo" });
      await vi.advanceTimersByTimeAsync(30_000);
      sessionService.setCurrentSession({ id: "session-1", title: "Test session", directory: "D:/repo" });
      const textsBefore = collectSentTexts(api).length;
      await vi.advanceTimersByTimeAsync(120_000);

      expect(collectSentTexts(api)).toHaveLength(textsBefore);
    });

    it("stops background operations when the event stream reconnects", async () => {
      const { api, summaryAggregator } = await setupService(false, { startAssistantRun: true });
      await launchAndEndTurn(api, summaryAggregator);
      const onReconnect = mocked.subscribeToEvents.mock.calls[0]?.[2] as () => void;

      onReconnect();
      const textsBefore = collectSentTexts(api).length;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(collectSentTexts(api)).toHaveLength(textsBefore);
    });

    it("keeps the compact card working past the reply and closes it when the command ends", async () => {
      const { api, summaryAggregator } = await setupService(false, { startAssistantRun: true });
      await useCompactMode();
      await launchAndEndTurn(api, summaryAggregator);

      await vi.advanceTimersByTimeAsync(30_000);
      const texts = collectSentTexts(api);
      expect(texts.some((text) => text.includes("✅ Finished Work"))).toBe(false);
      expect(texts.at(-1)).toMatch(/⏳ Working[\s\S]*sleep 90 · 🕒 \d+[ms]/);

      emitBackgroundBash(summaryAggregator, "completed");
      await flushPendingDispatch();

      const finished = collectSentTexts(api).filter((text) => text.includes("✅ Finished Work"));
      expect(finished).toHaveLength(1);
      expect(finished[0]).toContain("tool calls: 1");
    });

    it("keeps the parked compact card through a session error in a later turn", async () => {
      const { api, summaryAggregator } = await setupService(false, { startAssistantRun: true });
      await useCompactMode();
      await launchAndEndTurn(api, summaryAggregator);

      summaryAggregator.processEvent({
        type: "session.error",
        properties: { sessionID: "session-1", error: { name: "UnknownError", data: { message: "boom" } } },
      } as unknown as Event);
      await flushPendingDispatch();
      emitBackgroundBash(summaryAggregator, "completed");
      await flushPendingDispatch();

      expect(collectSentTexts(api).some((text) => text.includes("✅ Finished Work"))).toBe(true);
    });
  });

  it("uses edit streaming for visible thinking content when assistant responses use draft mode", async () => {
    const { api, summaryAggregator } = await setupService(true, {
      responseStreamingMode: "draft",
      showThinkingContent: true,
    });

    emitThinkingPart(summaryAggregator, "First thought");

    // First stream flush is 1s; keep the wait well above that.
    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 10_000 },
    );

    emitThinkingPart(summaryAggregator, "First thought\nSecond thought");

    await vi.waitFor(
      () => {
        expect(api.editMessageText).toHaveBeenCalledTimes(1);
      },
      { timeout: 10_000 },
    );
    expect(api.sendMessageDraft).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps hidden thinking as a separate non-draft message", async () => {
    const { api, summaryAggregator } = await setupService(true, {
      responseStreamingMode: "draft",
      showThinkingContent: false,
    });

    emitThinkingPart(summaryAggregator, "Hidden thought");

    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 10_000 },
    );
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.sendMessageDraft).not.toHaveBeenCalled();
  }, 30_000);

  it("does not send assistant run footer when it is disabled", async () => {
    const { api, summaryAggregator } = await setupService(true, {
      responseStreamingMode: "edit",
      showAssistantRunFooter: false,
      startAssistantRun: true,
    });

    emitAssistantTextPart(summaryAggregator, "Final answer");
    emitAssistantCompleted(summaryAggregator);
    emitSessionIdle(summaryAggregator);

    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );
    expect(defined(api.sendMessage.mock.calls[0]?.[1])).toBe("Final answer");
  });

  it("notifies the final draft response when assistant run footer is disabled", async () => {
    const { api, summaryAggregator } = await setupService(true, {
      responseStreamingMode: "draft",
      showAssistantRunFooter: false,
      startAssistantRun: true,
    });

    emitAssistantTextPart(summaryAggregator, "Final answer");
    emitAssistantCompleted(summaryAggregator);
    emitSessionIdle(summaryAggregator);

    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );
    expect(defined(api.sendMessage.mock.calls[0]?.[1])).toBe("Final answer");
    expect(defined(api.sendMessage.mock.calls[0])[2]?.disable_notification).toBeUndefined();
    expect(api.sendMessageDraft).not.toHaveBeenCalled();
  });

  it("keeps the final draft response silent when assistant run footer is enabled", async () => {
    const { api, summaryAggregator } = await setupService(true, {
      responseStreamingMode: "draft",
      showAssistantRunFooter: true,
      startAssistantRun: true,
    });

    emitAssistantTextPart(summaryAggregator, "Final answer");
    emitAssistantCompleted(summaryAggregator);
    emitSessionIdle(summaryAggregator);

    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
    expect(defined(api.sendMessage.mock.calls[0]?.[1])).toBe("Final answer");
    expect(defined(api.sendMessage.mock.calls[0])[2]).toEqual({ disable_notification: true });
    expect(defined(api.sendMessage.mock.calls[1]?.[1])).toContain("test-provider/test-model");
    expect(api.sendMessageDraft).not.toHaveBeenCalled();
  });

  describe("draft text before a question or permission prompt", () => {
    function sentMessageTexts(api: FakeBotApi): string[] {
      return api.sendMessage.mock.calls.map((call) => String(call[1]));
    }

    function indexOfSent(api: FakeBotApi, fragment: string): number {
      return sentMessageTexts(api).findIndex((text) => text.includes(fragment));
    }

    function countSent(api: FakeBotApi, text: string): number {
      return sentMessageTexts(api).filter((sentText) => sentText === text).length;
    }

    async function streamDraft(
      api: FakeBotApi,
      summaryAggregator: { processEvent(event: Event): void },
      text: string,
    ): Promise<void> {
      emitAssistantTextPart(summaryAggregator, text);
      await vi.waitFor(
        () => {
          expect(api.sendMessageDraft).toHaveBeenCalled();
        },
        { timeout: 3000 },
      );
    }

    it("sends the drafted text as a silent message above the question and not again at completion", async () => {
      const { api, summaryAggregator } = await setupService(false, {
        responseStreamingMode: "draft",
      });

      await streamDraft(api, summaryAggregator, "Analysis");
      emitQuestionAsked(summaryAggregator, "q1");

      await vi.waitFor(() => {
        expect(indexOfSent(api, "Which option for q1?")).toBeGreaterThanOrEqual(0);
      });
      const textIndex = indexOfSent(api, "Analysis");
      expect(textIndex).toBeGreaterThanOrEqual(0);
      expect(textIndex).toBeLessThan(indexOfSent(api, "Which option for q1?"));
      expect(defined(api.sendMessage.mock.calls[textIndex])[2]?.disable_notification).toBe(true);

      emitAssistantCompleted(summaryAggregator);
      await vi.waitFor(() => {
        expect(mocked.sendTtsResponseForSession).toHaveBeenCalledTimes(1);
      });
      expect(countSent(api, "Analysis")).toBe(1);
      expect(defined(mocked.sendTtsResponseForSession.mock.calls[0])[0].text).toBe("Analysis");
    });

    it("sends the drafted text above a permission request", async () => {
      const { api, summaryAggregator } = await setupService(false, {
        responseStreamingMode: "draft",
      });

      await streamDraft(api, summaryAggregator, "Analysis");
      emitPermissionAsked(summaryAggregator, "perm-1");

      await vi.waitFor(() => {
        expect(indexOfSent(api, "D:/shared/*")).toBeGreaterThanOrEqual(0);
      });
      expect(indexOfSent(api, "Analysis")).toBeGreaterThanOrEqual(0);
      expect(indexOfSent(api, "Analysis")).toBeLessThan(indexOfSent(api, "D:/shared/*"));

      emitAssistantCompleted(summaryAggregator);
      await vi.waitFor(() => {
        expect(mocked.sendTtsResponseForSession).toHaveBeenCalledTimes(1);
      });
      expect(countSent(api, "Analysis")).toBe(1);
    });

    it("does not send the text again when it is updated while the early send is in flight", async () => {
      const { api, summaryAggregator } = await setupService(false, {
        responseStreamingMode: "draft",
      });

      // No preview went out yet, so the early send renders the text afresh.
      emitAssistantTextPart(summaryAggregator, "Analysis");
      let releaseEarlySend: () => void = () => {};
      api.sendMessage.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseEarlySend = () => resolve({ message_id: 100 });
          }),
      );
      emitPermissionAsked(summaryAggregator, "perm-1");
      await vi.waitFor(() => {
        expect(countSent(api, "Analysis")).toBe(1);
      });

      // A trailing-whitespace update adds nothing worth sending on its own.
      const draftSendsBefore = api.sendMessageDraft.mock.calls.length;
      emitAssistantTextPart(summaryAggregator, "Analysis\n");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      releaseEarlySend();
      await vi.waitFor(() => {
        expect(indexOfSent(api, "D:/shared/*")).toBeGreaterThanOrEqual(0);
      });
      expect(api.sendMessageDraft.mock.calls.length).toBe(draftSendsBefore);

      emitAssistantCompleted(summaryAggregator);
      await vi.waitFor(() => {
        expect(mocked.sendTtsResponseForSession).toHaveBeenCalledTimes(1);
      });
      expect(sentMessageTexts(api).filter((text) => text.includes("Analysis"))).toHaveLength(1);
    });

    it("sends the text even when no draft preview went out before the prompt", async () => {
      const { api, summaryAggregator } = await setupService(false, {
        responseStreamingMode: "draft",
      });

      emitAssistantTextPart(summaryAggregator, "Analysis");
      emitQuestionAsked(summaryAggregator, "q1");

      await vi.waitFor(() => {
        expect(indexOfSent(api, "Which option for q1?")).toBeGreaterThanOrEqual(0);
      });
      expect(indexOfSent(api, "Analysis")).toBeGreaterThanOrEqual(0);
      expect(indexOfSent(api, "Analysis")).toBeLessThan(indexOfSent(api, "Which option for q1?"));
    });

    it("sends only the text written after the prompt when the message completes", async () => {
      const { api, summaryAggregator } = await setupService(false, {
        responseStreamingMode: "draft",
      });

      await streamDraft(api, summaryAggregator, "Analysis");
      emitQuestionAsked(summaryAggregator, "q1");
      await vi.waitFor(() => {
        expect(indexOfSent(api, "Which option for q1?")).toBeGreaterThanOrEqual(0);
      });

      emitAssistantTextPart(summaryAggregator, "Analysis\n\nMore after the answer");
      emitAssistantCompleted(summaryAggregator);

      await vi.waitFor(() => {
        expect(mocked.sendTtsResponseForSession).toHaveBeenCalledTimes(1);
      });
      const texts = sentMessageTexts(api);
      expect(texts.filter((text) => text.includes("Analysis"))).toEqual(["Analysis"]);
      expect(texts.some((text) => text.includes("More after the answer"))).toBe(true);
      expect(defined(mocked.sendTtsResponseForSession.mock.calls[0])[0].text).toBe(
        "Analysis\n\nMore after the answer",
      );
    });

    it("sends nothing extra when no text preceded the prompt", async () => {
      const { api, summaryAggregator } = await setupService(false, {
        responseStreamingMode: "draft",
      });

      emitQuestionAsked(summaryAggregator, "q1");

      await vi.waitFor(() => {
        expect(indexOfSent(api, "Which option for q1?")).toBeGreaterThanOrEqual(0);
      });
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("still shows the prompt and sends the text once at completion when the early send fails", async () => {
      const { api, summaryAggregator } = await setupService(false, {
        responseStreamingMode: "draft",
      });
      let telegramDown = true;
      api.sendMessage.mockImplementation(async (_chatId: number, text: string) => {
        if (telegramDown && text === "Analysis") {
          throw new Error("Network request failed");
        }
        return { message_id: 100 };
      });

      await streamDraft(api, summaryAggregator, "Analysis");
      emitQuestionAsked(summaryAggregator, "q1");
      await vi.waitFor(() => {
        expect(indexOfSent(api, "Which option for q1?")).toBeGreaterThanOrEqual(0);
      });

      telegramDown = false;
      const failedAttempts = countSent(api, "Analysis");
      emitAssistantCompleted(summaryAggregator);

      await vi.waitFor(() => {
        expect(mocked.sendTtsResponseForSession).toHaveBeenCalledTimes(1);
      });
      expect(countSent(api, "Analysis")).toBe(failedAttempts + 1);
      expect(indexOfSent(api, "Which option for q1?")).toBeLessThan(
        sentMessageTexts(api).lastIndexOf("Analysis"),
      );
    });

    it("sends the parent's drafted text above a subagent's permission request", async () => {
      const { api, summaryAggregator } = await setupService(false, {
        responseStreamingMode: "draft",
      });

      await streamDraft(api, summaryAggregator, "Analysis");
      emitSubagentStart(summaryAggregator);
      emitPermissionAsked(summaryAggregator, "perm-1", ["D:/shared/*"], "child-session-1");

      await vi.waitFor(() => {
        expect(indexOfSent(api, "D:/shared/*")).toBeGreaterThanOrEqual(0);
      });
      expect(indexOfSent(api, "Analysis")).toBeGreaterThanOrEqual(0);
      expect(indexOfSent(api, "Analysis")).toBeLessThan(indexOfSent(api, "D:/shared/*"));
    });

    it("sends the drafted text above the question in compact output mode", async () => {
      const { api, summaryAggregator } = await setupService(false, {
        responseStreamingMode: "draft",
      });
      const settingsStore = await import("../../../src/app/stores/settings-store.js");
      settingsStore.setCompactOutputMode(true);

      await streamDraft(api, summaryAggregator, "Analysis");
      emitQuestionAsked(summaryAggregator, "q1");

      await vi.waitFor(() => {
        expect(indexOfSent(api, "Which option for q1?")).toBeGreaterThanOrEqual(0);
      });
      expect(indexOfSent(api, "Analysis")).toBeGreaterThanOrEqual(0);
      expect(indexOfSent(api, "Analysis")).toBeLessThan(indexOfSent(api, "Which option for q1?"));
    });

    it("leaves edit mode as it was: the streamed message stays and is not sent twice", async () => {
      const { api, summaryAggregator } = await setupService(false, {
        responseStreamingMode: "edit",
      });

      emitAssistantTextPart(summaryAggregator, "Analysis");
      await vi.waitFor(
        () => {
          expect(indexOfSent(api, "Analysis")).toBeGreaterThanOrEqual(0);
        },
        { timeout: 3000 },
      );
      emitQuestionAsked(summaryAggregator, "q1");
      await vi.waitFor(() => {
        expect(indexOfSent(api, "Which option for q1?")).toBeGreaterThanOrEqual(0);
      });

      emitAssistantCompleted(summaryAggregator);
      await vi.waitFor(() => {
        expect(mocked.sendTtsResponseForSession).toHaveBeenCalledTimes(1);
      });
      expect(countSent(api, "Analysis")).toBe(1);
      expect(api.sendMessageDraft).not.toHaveBeenCalled();
    });
  });

  it("clears permission prompts when OpenCode resolves pending requests", async () => {
    const { api, summaryAggregator } = await setupService(true);
    const { permissionManager, interactionManager } = activeContainer;
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 500 })
      .mockResolvedValueOnce({ message_id: 501 });

    emitPermissionAsked(summaryAggregator, "permission-1");
    emitPermissionAsked(summaryAggregator, "permission-2", ["D:/other/*"]);

    await vi.waitFor(() => {
      expect(permissionManager.getPendingCount()).toBe(2);
    });

    emitPermissionReplied(summaryAggregator, "permission-2");

    await vi.waitFor(() => {
      expect(permissionManager.getPendingCount()).toBe(1);
    });
    expect(api.deleteMessage).toHaveBeenCalledWith(42, 501);
    expect(permissionManager.getRequestID(500)).toBe("permission-1");
    expect(interactionManager.getSnapshot()?.metadata.pendingCount).toBe(1);

    emitPermissionReplied(summaryAggregator, "permission-1");

    await vi.waitFor(() => {
      expect(permissionManager.isActive()).toBe(false);
      expect(interactionManager.getSnapshot()).toBeNull();
    });
    expect(api.deleteMessage).toHaveBeenCalledWith(42, 500);
  });

  it("discards a permission prompt resolved while its Telegram message is being sent", async () => {
    const { api, summaryAggregator } = await setupService(true);
    const { permissionManager, interactionManager } = activeContainer;
    let resolveSend: (message: { message_id: number }) => void = () => {};
    const pendingSend = new Promise<{ message_id: number }>((resolve) => {
      resolveSend = resolve;
    });
    api.sendMessage.mockReturnValueOnce(pendingSend);

    emitPermissionAsked(summaryAggregator, "permission-race");
    await vi.waitFor(() => {
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    emitPermissionReplied(summaryAggregator, "permission-race");
    await vi.waitFor(() => {
      expect(permissionManager.isResolved("permission-race")).toBe(true);
    });

    resolveSend({ message_id: 502 });

    await vi.waitFor(() => {
      expect(api.deleteMessage).toHaveBeenCalledWith(42, 502);
    });
    expect(permissionManager.isActive()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
  });

  function getInteractionManagers() {
    const { permissionManager, questionManager, interactionManager } = activeContainer;
    return { permissionManager, questionManager, interactionManager };
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  async function showPollWithWaitingPermission(summaryAggregator: {
    processEvent(event: Event): void;
  }): Promise<void> {
    const { questionManager, interactionManager } = getInteractionManagers();

    emitQuestionAsked(summaryAggregator, "question-1");
    await vi.waitFor(() => {
      expect(questionManager.getActiveMessageId()).not.toBeNull();
    });
    emitPermissionAsked(summaryAggregator, "permission-1");
    await vi.waitFor(() => {
      expect(interactionManager.getWaitingKind()).toBe("permission");
    });
  }

  it("leaves a poll waiting while permissions are on screen and shows it after the last one", async () => {
    const { api, summaryAggregator } = await setupService(true);
    const { permissionManager, questionManager, interactionManager } = getInteractionManagers();
    api.sendMessage.mockResolvedValueOnce({ message_id: 510 });

    emitPermissionAsked(summaryAggregator, "permission-1");
    await vi.waitFor(() => {
      expect(permissionManager.getPendingCount()).toBe(1);
    });

    emitQuestionAsked(summaryAggregator, "question-1");
    await vi.waitFor(() => {
      expect(interactionManager.getWaitingKind()).toBe("question");
    });
    expect(questionManager.isActive()).toBe(false);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    emitPermissionReplied(summaryAggregator, "permission-1");

    await vi.waitFor(() => {
      expect(questionManager.getActiveMessageId()).not.toBeNull();
    });
    expect(questionManager.getRequestID()).toBe("question-1");
    expect(interactionManager.getWaitingKind()).toBeNull();
  });

  it("leaves permissions waiting while a poll is on screen and shows them after cancel", async () => {
    const { api, summaryAggregator } = await setupService(true);
    const { permissionManager, questionManager, interactionManager } = getInteractionManagers();
    let nextMessageId = 600;
    api.sendMessage.mockImplementation(async () => ({ message_id: nextMessageId++ }));

    await showPollWithWaitingPermission(summaryAggregator);
    emitPermissionAsked(summaryAggregator, "permission-2", ["D:/other/*"]);
    await settle();
    const sendsBefore = api.sendMessage.mock.calls.length;
    expect(permissionManager.isActive()).toBe(false);

    questionManager.cancel();

    await vi.waitFor(() => {
      expect(permissionManager.getPendingCount()).toBe(2);
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(sendsBefore + 2);
    expect(interactionManager.getSnapshot()?.kind).toBe("permission");
  });

  it("never shows a waiting permission answered elsewhere", async () => {
    const { api, summaryAggregator } = await setupService(true);
    const { permissionManager, questionManager, interactionManager } = getInteractionManagers();

    await showPollWithWaitingPermission(summaryAggregator);

    emitPermissionReplied(summaryAggregator, "permission-1");
    await vi.waitFor(() => {
      expect(interactionManager.getWaitingKind()).toBeNull();
    });
    expect(questionManager.isActive()).toBe(true);
    const sendsBefore = api.sendMessage.mock.calls.length;

    questionManager.cancel();
    await settle();

    expect(api.sendMessage).toHaveBeenCalledTimes(sendsBefore);
    expect(permissionManager.isActive()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
  });

  it("replaces the poll on screen without releasing the waiting permission", async () => {
    const { summaryAggregator } = await setupService(true);
    const { permissionManager, questionManager, interactionManager } = getInteractionManagers();

    await showPollWithWaitingPermission(summaryAggregator);

    emitQuestionAsked(summaryAggregator, "question-2");
    await vi.waitFor(() => {
      expect(questionManager.getRequestID()).toBe("question-2");
    });
    await settle();

    expect(interactionManager.getWaitingKind()).toBe("permission");
    expect(permissionManager.isActive()).toBe(false);
  });

  it("shows the waiting permission when the question tool fails", async () => {
    const { summaryAggregator } = await setupService(true);
    const { permissionManager, questionManager } = getInteractionManagers();

    await showPollWithWaitingPermission(summaryAggregator);

    const aggregator = summaryAggregator as unknown as {
      onQuestionErrorCallback: (sessionId: string) => void;
    };
    aggregator.onQuestionErrorCallback("session-1");

    await vi.waitFor(() => {
      expect(permissionManager.getPendingCount()).toBe(1);
    });
    expect(questionManager.isActive()).toBe(false);
  });

  it("drops a waiting poll when the question tool fails behind permissions", async () => {
    const { summaryAggregator } = await setupService(true);
    const { permissionManager, interactionManager } = getInteractionManagers();

    emitPermissionAsked(summaryAggregator, "permission-1");
    await vi.waitFor(() => {
      expect(permissionManager.getPendingCount()).toBe(1);
    });
    emitQuestionAsked(summaryAggregator, "question-1");
    await vi.waitFor(() => {
      expect(interactionManager.getWaitingKind()).toBe("question");
    });

    const aggregator = summaryAggregator as unknown as {
      onQuestionErrorCallback: (sessionId: string) => void;
    };
    aggregator.onQuestionErrorCallback("session-1");

    expect(interactionManager.getWaitingKind()).toBeNull();
    expect(permissionManager.getPendingCount()).toBe(1);
  });

  it("drops a released request when a full reset lands before it is shown", async () => {
    const { api, summaryAggregator } = await setupService(true);
    const { permissionManager, questionManager, interactionManager } = getInteractionManagers();

    await showPollWithWaitingPermission(summaryAggregator);
    const sendsBefore = api.sendMessage.mock.calls.length;

    questionManager.cancel();
    interactionManager.reset("abort_command");
    await settle();

    expect(api.sendMessage).toHaveBeenCalledTimes(sendsBefore);
    expect(permissionManager.isActive()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
  });

  it("does not close the compact card while a permission waits, and closes it when the prompt appears", async () => {
    const { api, summaryAggregator } = await setupService(true);
    const [settingsStore, { t }] = await Promise.all([
      import("../../../src/app/stores/settings-store.js"),
      import("../../../src/i18n/index.js"),
    ]);
    settingsStore.setCompactOutputMode(true);
    const { questionManager } = getInteractionManagers();
    const waitingPermissionText = t("progress.compact.waiting_permission");
    const hasText = (fragment: string): boolean =>
      collectSentTexts(api).some((text) => text.includes(fragment));

    await showPollWithWaitingPermission(summaryAggregator);
    emitThinkingPart(summaryAggregator, "still working");
    await vi.waitFor(
      () => {
        expect(hasText("⏳ Working")).toBe(true);
      },
      { timeout: 3000 },
    );
    await settle();

    expect(hasText(waitingPermissionText)).toBe(false);
    expect(hasText("✅ Finished Work")).toBe(false);

    questionManager.cancel();

    await vi.waitFor(
      () => {
        expect(hasText("✅ Finished Work")).toBe(true);
      },
      { timeout: 3000 },
    );
    expect(hasText(waitingPermissionText)).toBe(false);
  });

  describe("a reply above what the agent did after it", () => {
    function sentMessageTexts(api: FakeBotApi): string[] {
      return api.sendMessage.mock.calls.map((call) => String(call[1]));
    }

    function indexOfSent(api: FakeBotApi, fragment: string): number {
      return sentMessageTexts(api).findIndex((text) => text.includes(fragment));
    }

    function expectSentInOrder(api: FakeBotApi, fragments: string[]): void {
      const indexes = fragments.map((fragment) => indexOfSent(api, fragment));
      for (const index of indexes) {
        expect(index).toBeGreaterThanOrEqual(0);
      }
      expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    }

    async function dispatch(): Promise<void> {
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    function emitCommand(
      summaryAggregator: { processEvent(event: Event): void },
      callId: string,
      command: string,
    ): void {
      emitBashTool(summaryAggregator, "running", { callId, command });
      emitBashTool(summaryAggregator, "completed", { callId, command });
    }

    it("opens a new message below a reply already on screen for the next command", async () => {
      const { api, summaryAggregator } = await setupService(false);
      useTrackerFakeTimers();

      emitCommand(summaryAggregator, "call-1", "Get-ChildItem");
      await flushPendingDispatch();
      emitAssistantTextPart(summaryAggregator, "First reply");
      await flushPendingDispatch();
      emitCommand(summaryAggregator, "call-2", "Get-Content package.json");
      await flushPendingDispatch();

      expectSentInOrder(api, ["Get-ChildItem", "First reply", "Get-Content package.json"]);
      const texts = collectSentTexts(api);
      expect(
        texts.some((text) => text.includes("Get-ChildItem") && text.includes("Get-Content")),
      ).toBe(false);
    });

    it("sends a reply still waiting on its timer above the command that followed it", async () => {
      const { api, summaryAggregator } = await setupService(false);
      useTrackerFakeTimers();

      emitCommand(summaryAggregator, "call-1", "Get-ChildItem");
      await flushPendingDispatch();
      emitAssistantTextPart(summaryAggregator, "First reply");
      await dispatch();
      emitCommand(summaryAggregator, "call-2", "Get-Content package.json");
      emitAssistantCompleted(summaryAggregator);
      await flushPendingDispatch();

      expectSentInOrder(api, ["Get-ChildItem", "First reply", "Get-Content package.json"]);
      expect(sentMessageTexts(api).filter((text) => text.includes("First reply"))).toHaveLength(1);
    });

    it("keeps an earlier command above the reply when its send is rate-limited", async () => {
      const { api, summaryAggregator } = await setupService(false);
      useTrackerFakeTimers();
      api.sendMessage.mockRejectedValueOnce(
        new Error("Call to 'sendMessage' failed! (429: Too Many Requests: retry after 2)"),
      );

      emitCommand(summaryAggregator, "call-1", "Get-ChildItem");
      await dispatch();
      emitAssistantTextPart(summaryAggregator, "First reply");
      await dispatch();
      emitCommand(summaryAggregator, "call-2", "Get-Content package.json");
      await flushPendingDispatch();
      await flushPendingDispatch();

      expectSentInOrder(api, ["Get-ChildItem", "First reply", "Get-Content package.json"]);
    });

    it("sends a pending reply above the thinking message of the next step", async () => {
      const { api, summaryAggregator } = await setupService(false, { showThinkingContent: false });
      useTrackerFakeTimers();

      emitAssistantTextPart(summaryAggregator, "First reply");
      await dispatch();
      emitAssistantMessage(summaryAggregator, "message-2");
      emitThinkingPart(summaryAggregator, "next step", "message-2");
      await flushPendingDispatch();

      expectSentInOrder(api, ["First reply", "💭 Thinking..."]);
    });

    it("sends a pending reply above a subagent card", async () => {
      const { api, summaryAggregator } = await setupService(false);
      useTrackerFakeTimers();

      emitAssistantTextPart(summaryAggregator, "First reply");
      await dispatch();
      emitSubagentStart(summaryAggregator);
      await dispatch();
      emitAssistantCompleted(summaryAggregator);
      await flushPendingDispatch();

      expectSentInOrder(api, ["First reply", "🧩"]);
    });

    it("sends a pending reply above a tool delivered as a document", async () => {
      const { api, summaryAggregator } = await setupService(true);
      useTrackerFakeTimers();

      emitAssistantTextPart(summaryAggregator, "First reply");
      await dispatch();
      emitWriteTool(summaryAggregator, "completed");
      emitAssistantCompleted(summaryAggregator);
      await flushPendingDispatch();

      await vi.waitFor(() => expect(api.sendDocument).toHaveBeenCalledTimes(1));
      const replyIndex = indexOfSent(api, "First reply");
      expect(replyIndex).toBeGreaterThanOrEqual(0);
      expect(defined(api.sendMessage.mock.invocationCallOrder[replyIndex])).toBeLessThan(
        defined(api.sendDocument.mock.invocationCallOrder[0]),
      );
    });

    it("sends a pending reply above a question", async () => {
      const { api, summaryAggregator } = await setupService(false);

      emitAssistantTextPart(summaryAggregator, "First reply");
      await dispatch();
      emitQuestionAsked(summaryAggregator, "q1");

      await vi.waitFor(() => {
        expect(indexOfSent(api, "Which option for q1?")).toBeGreaterThanOrEqual(0);
      });
      expectSentInOrder(api, ["First reply", "Which option for q1?"]);
    });

    it("finishes overlapping documents around a reply's text in the order they happened", async () => {
      const { api, summaryAggregator } = await setupService(true);
      useTrackerFakeTimers();
      const releases: Array<() => void> = [];
      api.sendDocument.mockImplementation(
        () =>
          new Promise((resolve) => {
            releases.push(() => resolve({ message_id: 101 }));
          }),
      );

      emitWriteTool(summaryAggregator, "completed", "call-write-1");
      await vi.waitFor(() => expect(api.sendDocument).toHaveBeenCalledTimes(1));
      emitBashTool(summaryAggregator, "running", { callId: "call-held", command: "sleep 60" });
      await dispatch();
      emitAssistantTextPart(summaryAggregator, "First reply");
      await dispatch();
      emitWriteTool(summaryAggregator, "completed", "call-write-2");
      await dispatch();

      releases.shift()?.();
      await vi.waitFor(() => expect(api.sendDocument).toHaveBeenCalledTimes(2));
      releases.shift()?.();
      await flushPendingDispatch();

      const replyIndex = indexOfSent(api, "First reply");
      const heldIndex = indexOfSent(api, "sleep 60");
      expect(heldIndex).toBeGreaterThanOrEqual(0);
      expect(heldIndex).toBeLessThan(replyIndex);
      const replyOrder = defined(api.sendMessage.mock.invocationCallOrder[replyIndex]);
      expect(defined(api.sendDocument.mock.invocationCallOrder[0])).toBeLessThan(replyOrder);
      expect(replyOrder).toBeLessThan(defined(api.sendDocument.mock.invocationCallOrder[1]));
    });

    it("sends a reply nothing follows once, at completion, as before", async () => {
      const { api, summaryAggregator } = await setupService(false);
      useTrackerFakeTimers();

      emitAssistantTextPart(summaryAggregator, "Only reply");
      await dispatch();
      emitAssistantCompleted(summaryAggregator);
      await flushPendingDispatch();

      expect(sentMessageTexts(api).filter((text) => text.includes("Only reply"))).toHaveLength(1);
      expect(api.editMessageText).not.toHaveBeenCalled();
    });

    describe("compact mode", () => {
      async function setupCompact(): Promise<Awaited<ReturnType<typeof setupService>>> {
        const setup = await setupService(false);
        const settingsStore = await import("../../../src/app/stores/settings-store.js");
        settingsStore.setCompactOutputMode(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        useTrackerFakeTimers();
        return setup;
      }

      it("closes the card above a reply and opens the next one below it", async () => {
        const { api, summaryAggregator } = await setupCompact();

        emitCommand(summaryAggregator, "call-1", "Get-ChildItem");
        await flushPendingDispatch();
        emitAssistantTextPart(summaryAggregator, "First reply");
        await flushPendingDispatch();
        emitBashTool(summaryAggregator, "running", { callId: "call-2", command: "Get-Content" });
        await flushPendingDispatch();
        emitBashTool(summaryAggregator, "completed", { callId: "call-2", command: "Get-Content" });
        emitAssistantCompleted(summaryAggregator);
        await flushPendingDispatch();
        emitAssistantMessage(summaryAggregator, "message-2");
        emitAssistantTextPart(summaryAggregator, "Second reply", "message-2");
        await dispatch();
        emitAssistantCompleted(summaryAggregator, "message-2");
        await flushPendingDispatch();

        const texts = sentMessageTexts(api);
        const cards = texts
          .map((text, index) => ({ text, index }))
          .filter(({ text }) => text.includes("⏳ Working"));
        expect(cards).toHaveLength(2);
        const firstReply = indexOfSent(api, "First reply");
        const secondReply = indexOfSent(api, "Second reply");
        expect(defined(cards[0]).index).toBeLessThan(firstReply);
        expect(firstReply).toBeLessThan(defined(cards[1]).index);
        expect(defined(cards[1]).index).toBeLessThan(secondReply);
        expect(defined(cards[1]).text).toContain("Get-Content");
        expect(collectSentTexts(api).filter((text) => text.includes("✅ Finished Work"))).toHaveLength(
          2,
        );
      });

      it("sends a reply deferred behind the card above a question", async () => {
        const { api, summaryAggregator } = await setupCompact();

        emitThinkingPart(summaryAggregator, "planning");
        await dispatch();
        emitAssistantTextPart(summaryAggregator, "First reply");
        await dispatch();
        emitQuestionAsked(summaryAggregator, "q1");

        await vi.waitFor(() => {
          expect(indexOfSent(api, "Which option for q1?")).toBeGreaterThanOrEqual(0);
        });
        expectSentInOrder(api, ["⏳ Working", "First reply", "Which option for q1?"]);
      });

      it("keeps going when a reply starts while the card is closing", async () => {
        const { api, summaryAggregator } = await setupCompact();

        emitCommand(summaryAggregator, "call-1", "Get-ChildItem");
        await flushPendingDispatch();
        emitAssistantTextPart(summaryAggregator, "First reply");
        await flushPendingDispatch();
        emitBashTool(summaryAggregator, "running", { callId: "call-2", command: "Get-Content" });
        emitAssistantMessage(summaryAggregator, "message-2");
        emitAssistantTextPart(summaryAggregator, "Second reply", "message-2");
        await flushPendingDispatch();
        emitBashTool(summaryAggregator, "completed", { callId: "call-2", command: "Get-Content" });
        emitAssistantCompleted(summaryAggregator);
        emitAssistantCompleted(summaryAggregator, "message-2");
        await flushPendingDispatch();

        await vi.waitFor(() => {
          expect(indexOfSent(api, "Second reply")).toBeGreaterThanOrEqual(0);
        });
        expect(indexOfSent(api, "First reply")).toBeLessThan(indexOfSent(api, "Second reply"));
      });
    });
  });
});

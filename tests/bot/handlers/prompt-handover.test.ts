import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { createIncomingPrompt } from "../../../src/app/types/prompt.js";

const mocked = vi.hoisted(() => ({
  version: "v1" as "v1" | "v2",
  status: "busy" as "busy" | "idle",
  statusMock: vi.fn(),
  promptAsyncMock: vi.fn(),
  resolveProjectAgentMock: vi.fn(),
  getStoredModelMock: vi.fn(),
  cancelInboxPromptMock: vi.fn(),
  getCurrentSessionMock: vi.fn(),
  getPromptQueueModeMock: vi.fn(),
  admitHandedOverPromptToInboxMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: { status: mocked.statusMock, promptAsync: mocked.promptAsyncMock },
  },
  opencodeV2Client: {},
  get opencodeServerVersion() {
    return mocked.version;
  },
}));

vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  getStoredAgent: vi.fn(() => "build"),
  resolveProjectAgent: mocked.resolveProjectAgentMock,
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: mocked.getStoredModelMock,
}));

vi.mock("../../../src/app/services/prompt-inbox-service.js", () => ({
  cancelInboxPrompt: mocked.cancelInboxPromptMock,
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: mocked.getCurrentSessionMock,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getPromptQueueMode: mocked.getPromptQueueModeMock,
}));

vi.mock("../../../src/bot/handlers/prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/bot/handlers/prompt.js")>()),
  admitHandedOverPromptToInbox: mocked.admitHandedOverPromptToInboxMock,
}));

import { promptHandover } from "../../../src/app/managers/prompt-handover-manager.js";
import { promptQueue } from "../../../src/app/managers/prompt-queue-manager.js";
import { config } from "../../../src/config.js";
import { t } from "../../../src/i18n/index.js";
import {
  __resetPromptHandoverForTests,
  handOverPreparedPrompt,
  handOverPromptQueue,
  initializePromptHandover,
  wakePromptHandover,
  withdrawAllHandedOverPrompts,
  withdrawHandedOverPrompts,
} from "../../../src/bot/handlers/prompt-handover.js";
import { createTestAppContainer } from "../../helpers/app-container.js";

const SESSION = { id: "ses-1", title: "Session", directory: "D:/repo" };
const MODEL = { providerID: "p", modelID: "m", variant: "high" };

let sendMessageMock: ReturnType<typeof vi.fn>;
let onDrainedMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
let deps: ReturnType<typeof createDeps>;

function createDeps() {
  return {
    ...createTestAppContainer(),
    bot: { api: { sendMessage: sendMessageMock } } as never,
  };
}

function sentTexts(): string[] {
  return mocked.promptAsyncMock.mock.calls.map(
    ([options]) => (options as { parts: Array<{ text: string }> }).parts[0]?.text ?? "",
  );
}

function makeContext(): Context {
  return { chat: { id: 42 }, api: {}, reply: vi.fn() } as unknown as Context;
}

describe("bot/handlers/prompt-handover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    promptQueue.__resetForTests();
    promptHandover.__resetForTests();
    __resetPromptHandoverForTests();
    mocked.version = "v1";
    mocked.status = "busy";
    mocked.statusMock.mockReset().mockImplementation(async () => ({
      data: { [SESSION.id]: { type: mocked.status } },
    }));
    mocked.promptAsyncMock.mockReset().mockImplementation(async () => {
      mocked.status = "busy";
      return { data: undefined };
    });
    mocked.resolveProjectAgentMock.mockReset().mockResolvedValue("build");
    mocked.getStoredModelMock.mockReset().mockReturnValue(MODEL);
    mocked.cancelInboxPromptMock.mockReset().mockResolvedValue(undefined);
    mocked.getCurrentSessionMock.mockReset().mockReturnValue(null);
    mocked.getPromptQueueModeMock.mockReset().mockReturnValue("steer");
    mocked.admitHandedOverPromptToInboxMock.mockReset().mockResolvedValue("msg-9");
    sendMessageMock = vi.fn().mockResolvedValue(undefined);
    onDrainedMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    deps = createDeps();
    initializePromptHandover(deps, onDrainedMock);
  });

  afterEach(() => {
    __resetPromptHandoverForTests();
    vi.useRealTimers();
  });

  describe("on OpenCode V1", () => {
    it("sends the held prompts after the running turn, one per turn, with the selection at /detach", async () => {
      promptQueue.add(createIncomingPrompt("first"));
      promptQueue.add(createIncomingPrompt("second"));

      await handOverPromptQueue(SESSION);
      mocked.getStoredModelMock.mockReturnValue({ providerID: "x", modelID: "y" });
      expect(promptQueue.size()).toBe(0);

      await vi.advanceTimersByTimeAsync(3000);
      expect(mocked.promptAsyncMock).not.toHaveBeenCalled();

      mocked.status = "idle";
      await vi.advanceTimersByTimeAsync(1500);
      expect(sentTexts()).toEqual(["first"]);
      expect(mocked.promptAsyncMock).toHaveBeenCalledWith({
        sessionID: "ses-1",
        directory: "D:/repo",
        parts: [{ type: "text", text: "first" }],
        agent: "build",
        model: { providerID: "p", modelID: "m" },
        variant: "high",
      });

      await vi.advanceTimersByTimeAsync(6000);
      expect(sentTexts()).toEqual(["first"]);

      mocked.status = "idle";
      await vi.advanceTimersByTimeAsync(1500);
      expect(sentTexts()).toEqual(["first", "second"]);
    });

    it("continues the attached queue once the last handed-over turn in the current session ends", async () => {
      mocked.getCurrentSessionMock.mockReturnValue(SESSION);
      mocked.status = "idle";
      promptQueue.add(createIncomingPrompt("only"));

      await handOverPromptQueue(SESSION);
      await vi.advanceTimersByTimeAsync(0);
      expect(sentTexts()).toEqual(["only"]);
      await vi.advanceTimersByTimeAsync(1500);
      expect(promptHandover.hasPendingPrompts("ses-1")).toBe(true);
      expect(onDrainedMock).not.toHaveBeenCalled();

      mocked.status = "idle";
      await vi.advanceTimersByTimeAsync(1500);

      expect(promptHandover.hasPendingPrompts("ses-1")).toBe(false);
      expect(onDrainedMock).toHaveBeenCalledTimes(1);
    });

    it("counts a turn too quick to be seen busy as over after the grace window", async () => {
      mocked.status = "idle";
      mocked.promptAsyncMock.mockResolvedValue({ data: undefined });
      promptQueue.add(createIncomingPrompt("quick"));
      promptQueue.add(createIncomingPrompt("next"));

      await handOverPromptQueue(SESSION);
      await vi.advanceTimersByTimeAsync(3000);
      expect(sentTexts()).toEqual(["quick"]);

      await vi.advanceTimersByTimeAsync(3000);
      expect(sentTexts()).toEqual(["quick", "next"]);
    });

    it("checks at once when the session goes idle", async () => {
      promptQueue.add(createIncomingPrompt("first"));
      await handOverPromptQueue(SESSION);
      await vi.advanceTimersByTimeAsync(0);

      mocked.status = "idle";
      wakePromptHandover("ses-1");
      await vi.advanceTimersByTimeAsync(0);

      expect(sentTexts()).toEqual(["first"]);
    });

    it("sends the next prompt after a failed one and posts the failure only when re-attached", async () => {
      mocked.status = "idle";
      mocked.promptAsyncMock.mockResolvedValueOnce({ error: { name: "BadRequest" } });
      promptQueue.add(createIncomingPrompt("fails"));
      promptQueue.add(createIncomingPrompt("goes"));
      deps.attachManager.attach("ses-1", "D:/repo");

      await handOverPromptQueue(SESSION);
      await vi.advanceTimersByTimeAsync(0);

      expect(sentTexts()).toEqual(["fails", "goes"]);
      expect(sendMessageMock).toHaveBeenCalledWith(
        config.telegram.allowedUserId,
        t("bot.prompt_send_error"),
      );
    });

    it("posts nothing about a failed prompt while detached", async () => {
      mocked.status = "idle";
      mocked.promptAsyncMock.mockResolvedValueOnce({ error: { name: "BadRequest" } });
      promptQueue.add(createIncomingPrompt("fails"));

      await handOverPromptQueue(SESSION);
      await vi.advanceTimersByTimeAsync(0);

      expect(sentTexts()).toEqual(["fails"]);
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it("sends nothing once /abort in that session withdrew them", async () => {
      promptQueue.add(createIncomingPrompt("withdrawn"));
      await handOverPromptQueue(SESSION);

      await withdrawHandedOverPrompts("ses-1", "abort_command");
      mocked.status = "idle";
      await vi.advanceTimersByTimeAsync(6000);

      expect(mocked.promptAsyncMock).not.toHaveBeenCalled();
      expect(promptHandover.get("ses-1")).toBeNull();
    });

    it("sends prompts handed over again while a withdrawn loop is still finishing", async () => {
      promptQueue.add(createIncomingPrompt("old"));
      await handOverPromptQueue(SESSION);
      await vi.advanceTimersByTimeAsync(0);

      let resolveStatus: (value: unknown) => void = () => undefined;
      mocked.statusMock.mockImplementationOnce(
        () => new Promise((resolve) => (resolveStatus = resolve)),
      );
      await vi.advanceTimersByTimeAsync(1500);

      await withdrawHandedOverPrompts("ses-1", "abort_command");
      promptQueue.add(createIncomingPrompt("new"));
      await handOverPromptQueue(SESSION);
      mocked.status = "idle";
      resolveStatus({ data: { [SESSION.id]: { type: "idle" } } });
      await vi.advanceTimersByTimeAsync(0);

      expect(sentTexts()).toEqual(["new"]);
    });

    it("sends nothing once /opencode_stop withdrew everything", async () => {
      promptQueue.add(createIncomingPrompt("withdrawn"));
      await handOverPromptQueue(SESSION);

      await withdrawAllHandedOverPrompts("opencode_stop");
      mocked.status = "idle";
      await vi.advanceTimersByTimeAsync(6000);

      expect(mocked.promptAsyncMock).not.toHaveBeenCalled();
    });

    it("hands a prompt prepared across /detach over to the session it arrived for", async () => {
      const ticket = promptHandover.takeTicket("ses-1");
      await handOverPromptQueue(SESSION);
      mocked.status = "idle";

      await expect(
        handOverPreparedPrompt(makeContext(), ticket, createIncomingPrompt("transcribed")),
      ).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(sentTexts()).toEqual(["transcribed"]);
    });

    it("leaves a prompt that arrived after the detach to the normal path", async () => {
      await handOverPromptQueue(SESSION);
      const ticket = promptHandover.takeTicket("ses-1");

      await expect(
        handOverPreparedPrompt(makeContext(), ticket, createIncomingPrompt("later")),
      ).resolves.toBe(false);
    });
  });

  describe("on OpenCode V2", () => {
    beforeEach(() => {
      mocked.version = "v2";
    });

    it("leaves waiting inbox prompts in OpenCode at /detach and clears their buttons", async () => {
      promptQueue.confirmReservation(promptQueue.reserve()!, {
        displayText: "steered",
        inbox: { sessionId: "ses-1", inboxId: "msg-1", delivery: "steer" },
      });

      await handOverPromptQueue(SESSION);

      expect(promptQueue.size()).toBe(0);
      expect(mocked.cancelInboxPromptMock).not.toHaveBeenCalled();
      expect(mocked.promptAsyncMock).not.toHaveBeenCalled();
      expect(promptHandover.get("ses-1")?.inboxEntries).toEqual([
        { sessionId: "ses-1", inboxId: "msg-1", delivery: "steer" },
      ]);
    });

    it("cancels the handed-over inbox prompts on /opencode_stop", async () => {
      promptQueue.confirmReservation(promptQueue.reserve()!, {
        displayText: "steered",
        inbox: { sessionId: "ses-1", inboxId: "msg-1", delivery: "steer" },
      });
      await handOverPromptQueue(SESSION);

      await withdrawAllHandedOverPrompts("opencode_stop");

      expect(mocked.cancelInboxPromptMock).toHaveBeenCalledWith(
        { sessionId: "ses-1", inboxId: "msg-1", delivery: "steer" },
        "opencode_stop",
      );
    });

    it("sends a prompt prepared across /detach into that session's inbox with the selection at /detach", async () => {
      const ticket = promptHandover.takeTicket("ses-1");
      await handOverPromptQueue(SESSION);
      const input = createIncomingPrompt("transcribed");
      const ctx = makeContext();

      await expect(handOverPreparedPrompt(ctx, ticket, input)).resolves.toBe(true);

      expect(mocked.admitHandedOverPromptToInboxMock).toHaveBeenCalledWith(
        ctx.api,
        input,
        { id: "ses-1", directory: "D:/repo" },
        { agent: "build", ...MODEL },
        "steer",
        deps,
      );
      expect(ctx.reply).not.toHaveBeenCalled();
      expect(promptHandover.get("ses-1")?.inboxEntries).toEqual([
        { sessionId: "ses-1", inboxId: "msg-9", delivery: "steer" },
      ]);
    });
  });
});

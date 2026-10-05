import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Context } from "grammy";
import { t } from "../../../src/i18n/index.js";
import type { PendingInteractiveRequest } from "../../../src/app/services/scheduled-task-executor-service.js";

const mocked = vi.hoisted(() => ({
  runGuestPromptMock: vi.fn(),
  answerGuestQuestionMock: vi.fn(),
  dismissGuestQuestionMock: vi.fn(),
  replyGuestPermissionMock: vi.fn(),
  describeGuestActivityMock: vi.fn(),
  config: { bot: { messageFormatMode: "raw" } },
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
    answerGuestQuestion: mocked.answerGuestQuestionMock,
    dismissGuestQuestion: mocked.dismissGuestQuestionMock,
    replyGuestPermission: mocked.replyGuestPermissionMock,
    describeGuestActivity: mocked.describeGuestActivityMock,
  };
});

import { runGuestTurn } from "../../../src/bot/handlers/guest-message-handler.js";
import {
  __resetGuestPromptsForTests,
  answerGuestQuestionWithText,
  handleGuestPromptCallback,
} from "../../../src/bot/handlers/guest-prompts.js";
import type { GuestTurnHooks } from "../../../src/app/services/guest-session-service.js";

const SESSION = { sessionId: "session-1", directory: "/infra" };

const PERMISSION: PendingInteractiveRequest = {
  kind: "permission",
  request: {
    id: "perm-1",
    sessionID: "session-1",
    permission: "bash",
    patterns: ["virsh undefine vm-3d"],
  },
};

const QUESTION: PendingInteractiveRequest = {
  kind: "question",
  request: {
    id: "q-1",
    sessionID: "session-1",
    questions: [
      {
        header: "Confirm",
        question: "Delete vm-3d on vms-epyc9?",
        options: [
          { label: "Yes", description: "Delete it now" },
          { label: "No", description: "" },
        ],
      },
    ],
  },
};

function createApi() {
  return {
    editMessageTextInline: vi.fn().mockResolvedValue(true),
  };
}

function tap(api: ReturnType<typeof createApi>, data: string, inlineMessageId = "inline-1") {
  const answerCallbackQuery = vi.fn().mockResolvedValue(true);
  const ctx = {
    api,
    callbackQuery: { id: "cb", data, inline_message_id: inlineMessageId },
    answerCallbackQuery,
  } as unknown as Context;
  return { ctx, answerCallbackQuery };
}

/** Starts a turn that reports `requests` one poll after another, then waits to be finished. */
function startTurn(api: ReturnType<typeof createApi>) {
  let hooks: GuestTurnHooks = {};
  let finish: (reply: string) => void = () => {};
  mocked.runGuestPromptMock.mockImplementation(
    (_chatId: string, _thread: unknown, _text: string, turnHooks: GuestTurnHooks) => {
      hooks = turnHooks;
      hooks.onSessionReady?.(SESSION);
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
  );
  const turn = runGuestTurn(api as unknown as Api, "inline-1", "-100", (turnHooks) =>
    mocked.runGuestPromptMock("-100", undefined, "hi", turnHooks),
  );
  return {
    turn,
    poll: (request: PendingInteractiveRequest | null) => hooks.onInteractiveRequest?.(request),
    finish: (reply: string) => finish(reply),
  };
}

function lastEdit(api: ReturnType<typeof createApi>) {
  return api.editMessageTextInline.mock.calls.at(-1);
}

function buttons(api: ReturnType<typeof createApi>): Array<{ text: string; data: string }> {
  const markup = lastEdit(api)?.[2]?.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
  return markup.inline_keyboard.flat().map((key) => ({ text: key.text, data: key.callback_data }));
}

describe("bot/handlers/guest-prompts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetGuestPromptsForTests();
    mocked.answerGuestQuestionMock.mockResolvedValue(true);
    mocked.dismissGuestQuestionMock.mockResolvedValue(true);
    mocked.replyGuestPermissionMock.mockResolvedValue(true);
    mocked.describeGuestActivityMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws a permission request on the turn's message and sends the tapped answer", async () => {
    const api = createApi();
    const turn = startTurn(api);

    await turn.poll(PERMISSION);

    expect(lastEdit(api)?.[1]).toContain("virsh undefine vm-3d");
    expect(buttons(api)).toEqual([
      { text: t("permission.button.allow"), data: "gq:p:once" },
      { text: t("permission.button.always"), data: "gq:p:always" },
      { text: t("permission.button.reject"), data: "gq:p:reject" },
    ]);

    const { ctx, answerCallbackQuery } = tap(api, "gq:p:once");
    await handleGuestPromptCallback(ctx);

    expect(mocked.replyGuestPermissionMock).toHaveBeenCalledWith("/infra", "perm-1", "once");
    expect(answerCallbackQuery).toHaveBeenCalledWith();
    expect(lastEdit(api)?.[1]).toContain(t("permission.reply.once"));

    // OpenCode still lists the request for a moment: it is not drawn again.
    const edits = api.editMessageTextInline.mock.calls.length;
    await turn.poll(PERMISSION);
    expect(api.editMessageTextInline).toHaveBeenCalledTimes(edits);

    turn.finish("Deleted.");
    await turn.turn;
    expect(lastEdit(api)).toEqual(["inline-1", "Deleted."]);
  });

  it("keeps progress from covering a question until it is answered", async () => {
    vi.useFakeTimers();
    const api = createApi();
    const turn = startTurn(api);

    await turn.poll(QUESTION);
    const edits = api.editMessageTextInline.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.editMessageTextInline).toHaveBeenCalledTimes(edits);
    turn.finish("done");
    await turn.turn;
  });

  it("answers a question with the tapped option", async () => {
    const api = createApi();
    const turn = startTurn(api);
    await turn.poll(QUESTION);

    expect(lastEdit(api)?.[1]).toContain("Delete vm-3d on vms-epyc9?");
    expect(lastEdit(api)?.[1]).toContain("Yes — Delete it now");
    expect(buttons(api)).toEqual([
      { text: "Yes", data: "gq:o:0" },
      { text: "No", data: "gq:o:1" },
      { text: t("guest.question.dismiss"), data: "gq:x" },
    ]);

    await handleGuestPromptCallback(tap(api, "gq:o:0").ctx);

    expect(mocked.answerGuestQuestionMock).toHaveBeenCalledWith("/infra", "q-1", [["Yes"]]);
    expect(lastEdit(api)?.[1]).toBe(t("guest.question.answered", { answer: "Yes" }));
    turn.finish("done");
    await turn.turn;
  });

  it("walks a batch of questions on one message, with several choices where allowed", async () => {
    const api = createApi();
    const turn = startTurn(api);
    await turn.poll({
      kind: "question",
      request: {
        id: "q-2",
        sessionID: "session-1",
        questions: [
          {
            header: "Host",
            question: "Which host?",
            options: [{ label: "epyc9", description: "" }],
          },
          {
            header: "VMs",
            question: "Which VMs?",
            multiple: true,
            custom: false,
            options: [
              { label: "vm-a", description: "" },
              { label: "vm-b", description: "", value: "vm-b-id" },
            ],
          },
        ],
      },
    });

    expect(lastEdit(api)?.[1]).toContain("Host (1/2)");
    await handleGuestPromptCallback(tap(api, "gq:o:0").ctx);
    expect(lastEdit(api)?.[1]).toContain("VMs (2/2)");
    expect(lastEdit(api)?.[1]).not.toContain(t("guest.question.custom_hint"));

    const empty = tap(api, "gq:done");
    await handleGuestPromptCallback(empty.ctx);
    expect(empty.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("question.select_one_required_callback"),
    });

    await handleGuestPromptCallback(tap(api, "gq:o:1").ctx);
    await handleGuestPromptCallback(tap(api, "gq:o:0").ctx);
    expect(
      buttons(api)
        .slice(0, 2)
        .map((key) => key.text),
    ).toEqual(["✅ vm-a", "✅ vm-b"]);
    await handleGuestPromptCallback(tap(api, "gq:done").ctx);

    expect(mocked.answerGuestQuestionMock).toHaveBeenCalledWith("/infra", "q-2", [
      ["epyc9"],
      ["vm-a", "vm-b-id"],
    ]);
    turn.finish("done");
    await turn.turn;
  });

  it("takes a typed answer for a question that accepts one", async () => {
    const api = createApi();
    const turn = startTurn(api);
    await turn.poll(QUESTION);

    const note = await answerGuestQuestionWithText(
      api as unknown as Api,
      "session-1",
      "only vm-3d",
    );

    expect(note).toBe(t("guest.question.answer_received", { answer: "only vm-3d" }));
    expect(mocked.answerGuestQuestionMock).toHaveBeenCalledWith("/infra", "q-1", [["only vm-3d"]]);
    await expect(
      answerGuestQuestionWithText(api as unknown as Api, "session-1", "again"),
    ).resolves.toBeNull();
    turn.finish("done");
    await turn.turn;
  });

  it("goes back to progress when the request is answered elsewhere", async () => {
    const api = createApi();
    const turn = startTurn(api);
    await turn.poll(PERMISSION);

    await turn.poll(null);

    expect(lastEdit(api)?.[1]).toContain(t("guest.working", { elapsed: "" }).trim());
    expect(lastEdit(api)?.[2]).toBeUndefined();
    const { ctx, answerCallbackQuery } = tap(api, "gq:p:once");
    await handleGuestPromptCallback(ctx);
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: t("guest.prompt.expired") });
    expect(mocked.replyGuestPermissionMock).not.toHaveBeenCalled();
    turn.finish("done");
    await turn.turn;
  });

  it("dismisses a question only when asked to", async () => {
    const api = createApi();
    const turn = startTurn(api);
    await turn.poll(QUESTION);

    await handleGuestPromptCallback(tap(api, "gq:x").ctx);

    expect(mocked.dismissGuestQuestionMock).toHaveBeenCalledWith("/infra", "q-1");
    expect(lastEdit(api)?.[1]).toBe(t("guest.question.dismissed"));
    turn.finish("done");
    await turn.turn;
  });

  it("keeps the question up when OpenCode refuses the answer", async () => {
    mocked.answerGuestQuestionMock.mockResolvedValue(false);
    const api = createApi();
    const turn = startTurn(api);
    await turn.poll(QUESTION);

    const { ctx, answerCallbackQuery } = tap(api, "gq:o:1");
    await handleGuestPromptCallback(ctx);

    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: t("guest.prompt.failed") });
    expect(buttons(api)[0]).toEqual({ text: "Yes", data: "gq:o:0" });
    turn.finish("done");
    await turn.turn;
  });

  it("answers a tap on a message with no open request as expired", async () => {
    const api = createApi();

    const { ctx, answerCallbackQuery } = tap(api, "gq:o:0", "inline-unknown");
    await handleGuestPromptCallback(ctx);

    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: t("guest.prompt.expired") });
  });
});

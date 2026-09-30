import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import type { PermissionRequest } from "../../../src/app/types/permission.js";
import {
  applyPermissionPromptChanges,
  showPermissionRequest,
} from "../../../src/bot/menus/permission-menu.js";
import { t } from "../../../src/i18n/index.js";
import { createTestAppContainer } from "../../helpers/app-container.js";
import type { AppContainer } from "../../../src/app/bootstrap/app-container.js";

let deps: AppContainer;

const PERMISSION: PermissionRequest = {
  id: "perm-1",
  sessionID: "session-1",
  permission: "bash",
  patterns: ["npm test"],
  metadata: {},
  always: [],
};

function createApi(onSend: () => void): {
  api: Context["api"];
  sendMessage: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockImplementation(async () => {
    onSend();
    return { message_id: 201 };
  });
  const deleteMessage = vi.fn().mockResolvedValue(true);
  return {
    api: { sendMessage, deleteMessage, editMessageText: vi.fn() } as unknown as Context["api"],
    sendMessage,
    deleteMessage,
  };
}

beforeEach(() => {
  deps = createTestAppContainer();
});

describe("bot/menus/permission-menu", () => {
  function editApi(): { api: Context["api"]; editMessageText: ReturnType<typeof vi.fn> } {
    const editMessageText = vi.fn().mockResolvedValue(true);
    return { api: { editMessageText } as unknown as Context["api"], editMessageText };
  }

  it("ends a prompt with its outcome line and no buttons", async () => {
    const { api, editMessageText } = editApi();

    await applyPermissionPromptChanges(
      api,
      42,
      [{ messageId: 201, request: PERMISSION, openCount: 0, outcome: { kind: "not_answered" } }],
      deps,
    );

    const [, messageId, text, options] = editMessageText.mock.calls[0] ?? [];
    expect(messageId).toBe(201);
    expect(text).toBe(
      `${t("permission.header", { emoji: "⚡", name: t("permission.name.bash") })}• npm test\n\n${t("permission.outcome.not_answered")}`,
    );
    expect(options).toBeUndefined();
  });

  it("shortens a single pattern that alone does not fit instead of hiding it", async () => {
    const { api, editMessageText } = editApi();
    const command = `echo ${"x".repeat(5000)}`;

    await applyPermissionPromptChanges(
      api,
      42,
      [
        {
          messageId: 201,
          request: { ...PERMISSION, patterns: [command] },
          openCount: 0,
          outcome: { kind: "not_answered" },
        },
      ],
      deps,
    );

    const text = String(editMessageText.mock.calls[0]?.[2]);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("• echo xxx");
    expect(text).toContain("…\n");
    expect(text.endsWith(`\n${t("permission.outcome.not_answered")}`)).toBe(true);
  });

  it("keeps the buttons and shows the lower count on a prompt left partly open", async () => {
    const { api, editMessageText } = editApi();

    await applyPermissionPromptChanges(
      api,
      42,
      [{ messageId: 201, request: PERMISSION, openCount: 2, outcome: null }],
      deps,
    );

    const [, , text, options] = editMessageText.mock.calls[0] ?? [];
    expect(String(text)).toContain(t("permission.grouped_count", { count: 2 }));
    expect(options).toHaveProperty("reply_markup");
  });

  it("cuts the pattern list so the prompt and its line fit one message", async () => {
    const { api, editMessageText } = editApi();
    const patterns = Array.from(
      { length: 200 },
      (_, index) => `D:/very/long/path/number/${index}/*`,
    );

    await applyPermissionPromptChanges(
      api,
      42,
      [
        {
          messageId: 201,
          request: { ...PERMISSION, patterns },
          openCount: 0,
          outcome: { kind: "replied", reply: "reject", outside: true },
        },
      ],
      deps,
    );

    const text = String(editMessageText.mock.calls[0]?.[2]);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/• D:\/very[^\n]*…\n/);
    expect(text).not.toContain("number/199/*");
    expect(
      text.endsWith(`\n${t("permission.outcome.reject")}${t("permission.outcome.outside_suffix")}`),
    ).toBe(true);
  });

  it("shows the prompt and opens the permission slot", async () => {
    const { api, deleteMessage } = createApi(() => {});

    await showPermissionRequest(api, 42, PERMISSION, deps);

    expect(deps.permissionManager.getRequestID(201)).toBe("perm-1");
    expect(deps.interactionManager.getSnapshot()?.kind).toBe("permission");
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("deletes the prompt and queues the request when a poll took the slot during sending", async () => {
    const { api, deleteMessage } = createApi(() => {
      deps.questionManager.startQuestions(
        [{ header: "Q", question: "Pick", options: [] }],
        "req-1",
        "session-1",
      );
    });

    await showPermissionRequest(api, 42, PERMISSION, deps);

    expect(deleteMessage).toHaveBeenCalledWith(42, 201);
    expect(deps.permissionManager.isActive()).toBe(false);
    expect(deps.questionManager.isActive()).toBe(true);
    expect(deps.interactionManager.getWaitingKind()).toBe("permission");
  });

  it("deletes and drops the prompt when a reset happened during sending", async () => {
    const { api, deleteMessage } = createApi(() => {
      deps.questionManager.startQuestions(
        [{ header: "Q", question: "Pick", options: [] }],
        "req-1",
        "session-1",
      );
      deps.interactionManager.reset("abort_command");
    });

    await showPermissionRequest(api, 42, PERMISSION, deps);

    expect(deleteMessage).toHaveBeenCalledWith(42, 201);
    expect(deps.permissionManager.isActive()).toBe(false);
    expect(deps.interactionManager.getWaitingKind()).toBeNull();
  });

  it("deletes and drops the prompt when it was answered elsewhere during sending", async () => {
    const { api, deleteMessage } = createApi(() => {
      deps.questionManager.startQuestions(
        [{ header: "Q", question: "Pick", options: [] }],
        "req-1",
        "session-1",
      );
      deps.permissionManager.settleRequest("perm-1", null);
    });

    await showPermissionRequest(api, 42, PERMISSION, deps);

    expect(deleteMessage).toHaveBeenCalledWith(42, 201);
    expect(deps.interactionManager.getWaitingKind()).toBeNull();
  });

  it("skips sending a request that is already stale", async () => {
    const { api, sendMessage } = createApi(() => {});
    const generation = deps.permissionManager.getGeneration();
    deps.interactionManager.reset("abort_command");

    await showPermissionRequest(api, 42, PERMISSION, deps, generation);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends one prompt when the same request is shown twice at once", async () => {
    const { api, sendMessage } = createApi(() => {});

    await Promise.all([
      showPermissionRequest(api, 42, PERMISSION, deps),
      showPermissionRequest(api, 42, PERMISSION, deps),
      showPermissionRequest(api, 42, PERMISSION, deps),
    ]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.permissionManager.getMessageIds()).toEqual([201]);
    expect(deps.permissionManager.getRequestIDs(201)).toEqual(["perm-1"]);
  });

  it("groups an equivalent request shown while the first prompt is being sent", async () => {
    const { api, sendMessage } = createApi(() => {});
    vi.mocked(api.editMessageText).mockResolvedValue(true);

    await Promise.all([
      showPermissionRequest(api, 42, PERMISSION, deps),
      showPermissionRequest(api, 42, { ...PERMISSION, id: "perm-2" }, deps),
    ]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.permissionManager.getRequestIDs(201)).toEqual(["perm-1", "perm-2"]);
  });

  it("lets a waiting show go on when the first send fails", async () => {
    const { api, sendMessage } = createApi(() => {});
    sendMessage.mockRejectedValueOnce(new Error("telegram down"));

    const results = await Promise.allSettled([
      showPermissionRequest(api, 42, PERMISSION, deps),
      showPermissionRequest(api, 42, PERMISSION, deps),
    ]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(deps.permissionManager.getMessageIds()).toEqual([201]);
  });
});

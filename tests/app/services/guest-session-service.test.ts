import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createMock: vi.fn(),
  getMock: vi.fn(),
  promptAsyncMock: vi.fn(),
  waitMock: vi.fn(),
  registerIgnoreMock: vi.fn(),
  getCurrentProjectMock: vi.fn(),
  getGuestSessionMock: vi.fn(),
  setGuestSessionMock: vi.fn(),
  resolveProjectAgentMock: vi.fn(),
  getStoredModelMock: vi.fn(),
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
  getGuestSession: mocked.getGuestSessionMock,
  setGuestSession: mocked.setGuestSessionMock,
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
  GuestNoProjectError,
  runGuestPrompt,
} from "../../../src/app/services/guest-session-service.js";

const PROJECT_DIR = "/work/repo";

describe("app/services/guest-session-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getCurrentProjectMock.mockReturnValue({ id: "p1", worktree: PROJECT_DIR });
    mocked.getGuestSessionMock.mockReturnValue(undefined);
    mocked.createMock.mockResolvedValue({
      data: { id: "new-session", directory: PROJECT_DIR },
      error: undefined,
    });
    mocked.getMock.mockResolvedValue({ data: { id: "old-session" }, error: undefined });
    mocked.promptAsyncMock.mockResolvedValue({ data: undefined, error: undefined });
    mocked.waitMock.mockResolvedValue("the answer");
    mocked.resolveProjectAgentMock.mockResolvedValue("plan");
    mocked.getStoredModelMock.mockReturnValue({
      providerID: "openai",
      modelID: "gpt-5",
      variant: "high",
    });
  });

  it("creates a session for a new guest chat, remembers it and returns the reply", async () => {
    const reply = await runGuestPrompt("-100", "Team chat", "hello");

    expect(reply).toBe("the answer");
    expect(mocked.createMock).toHaveBeenCalledWith({
      directory: PROJECT_DIR,
      title: "Guest: Team chat",
    });
    expect(mocked.setGuestSessionMock).toHaveBeenCalledWith("-100", {
      sessionId: "new-session",
      directory: PROJECT_DIR,
    });
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
  });

  it("continues the guest chat's existing session in the same project", async () => {
    mocked.getGuestSessionMock.mockReturnValue({ sessionId: "old-session", directory: PROJECT_DIR });

    await runGuestPrompt("-100", "Team chat", "follow-up");

    expect(mocked.createMock).not.toHaveBeenCalled();
    expect(mocked.promptAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "old-session" }),
    );
  });

  it("starts a new session once the current project changed", async () => {
    mocked.getGuestSessionMock.mockReturnValue({ sessionId: "old-session", directory: "/other" });

    await runGuestPrompt("-100", "Team chat", "hello");

    expect(mocked.getMock).not.toHaveBeenCalled();
    expect(mocked.createMock).toHaveBeenCalled();
  });

  it("starts a new session when the remembered one no longer exists", async () => {
    mocked.getGuestSessionMock.mockReturnValue({ sessionId: "old-session", directory: PROJECT_DIR });
    mocked.getMock.mockResolvedValue({ data: undefined, error: new Error("not found") });

    await runGuestPrompt("-100", "Team chat", "hello");

    expect(mocked.createMock).toHaveBeenCalled();
    expect(mocked.promptAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "new-session" }),
    );
  });

  it("fails without a selected project", async () => {
    mocked.getCurrentProjectMock.mockReturnValue(undefined);

    await expect(runGuestPrompt("-100", "Team chat", "hello")).rejects.toBeInstanceOf(
      GuestNoProjectError,
    );
    expect(mocked.promptAsyncMock).not.toHaveBeenCalled();
  });

  it("surfaces a prompt error without waiting for a reply", async () => {
    const error = new Error("rejected");
    mocked.promptAsyncMock.mockResolvedValue({ data: undefined, error });

    await expect(runGuestPrompt("-100", "Team chat", "hello")).rejects.toBe(error);
    expect(mocked.waitMock).not.toHaveBeenCalled();
  });
});

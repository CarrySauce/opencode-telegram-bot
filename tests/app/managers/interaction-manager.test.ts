import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ALLOWED_INTERACTION_COMMANDS,
  InteractionManager,
} from "../../../src/app/managers/interaction-manager.js";
import { PermissionManager } from "../../../src/app/managers/permission-manager.js";
import { QuestionManager } from "../../../src/app/managers/question-manager.js";
import { RenameManager } from "../../../src/app/managers/rename-manager.js";
import { TaskCreationManager } from "../../../src/app/managers/scheduled-task-creation-manager.js";
import type { PermissionRequest } from "../../../src/app/types/permission.js";
import type { WaitingAgentRequest } from "../../../src/app/types/interaction.js";
import { defined } from "../../helpers/defined.js";
import { logger } from "../../../src/utils/logger.js";
import type { Question } from "../../../src/app/types/question.js";

let interactionManager: InteractionManager;
let permissionManager: PermissionManager;
let questionManager: QuestionManager;
let renameManager: RenameManager;
let taskCreationManager: TaskCreationManager;

beforeEach(() => {
  interactionManager = new InteractionManager();
  permissionManager = new PermissionManager(interactionManager);
  questionManager = new QuestionManager(interactionManager);
  renameManager = new RenameManager(interactionManager);
  taskCreationManager = new TaskCreationManager(interactionManager);
});

describe("interactionManager", () => {
  it("starts interaction with defaults", () => {
    const state = interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: { requestId: "q-1" },
    });

    expect(state.kind).toBe("custom");
    expect(state.expectedInput).toBe("callback");
    expect(state.metadata).toEqual({ requestId: "q-1" });
    expect(state.allowedCommands).toEqual([...DEFAULT_ALLOWED_INTERACTION_COMMANDS]);
    expect(state.createdAt).toBeTypeOf("number");
    expect(state.expiresAt).toBeNull();
    expect(interactionManager.isActive()).toBe(true);
  });

  it("normalizes and deduplicates allowed commands", () => {
    const state = interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      allowedCommands: ["/Help", "status", "/help", " /STATUS@MyBot ", "detach", "", " / "],
    });

    expect(state.allowedCommands).toEqual(["/help", "/status", "/detach"]);
  });

  it("transitions active interaction", () => {
    interactionManager.start({
      kind: "custom",
      expectedInput: "text",
      metadata: { step: 1 },
    });

    const transitioned = interactionManager.transition({
      expectedInput: "mixed",
      allowedCommands: ["/abort"],
      metadata: { step: 2 },
      expiresInMs: 5000,
    });

    expect(transitioned).not.toBeNull();
    expect(transitioned?.kind).toBe("custom");
    expect(transitioned?.expectedInput).toBe("mixed");
    expect(transitioned?.allowedCommands).toEqual(["/abort"]);
    expect(transitioned?.metadata).toEqual({ step: 2 });
    expect(typeof transitioned?.expiresAt).toBe("number");
  });

  it("tracks expiration by expiresAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      expiresInMs: 1000,
    });

    expect(interactionManager.isExpired()).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(interactionManager.isExpired()).toBe(true);
  });

  it("clears active interaction", () => {
    interactionManager.start({
      kind: "custom",
      expectedInput: "mixed",
    });

    interactionManager.clear("test");

    expect(interactionManager.isActive()).toBe(false);
    expect(interactionManager.get()).toBeNull();
  });

  it("logs a full reset at info only when something was open", () => {
    const infoSpy = vi.spyOn(logger, "info");
    const debugSpy = vi.spyOn(logger, "debug");
    const resetLines = (spy: typeof infoSpy) =>
      spy.mock.calls.filter(([line]) => String(line).startsWith("[InteractionCleanup] Cleared state"));

    interactionManager.reset("test_idle");
    expect(resetLines(infoSpy)).toHaveLength(0);
    expect(resetLines(debugSpy)).toHaveLength(1);

    interactionManager.start({ kind: "custom", expectedInput: "mixed" });
    interactionManager.reset("test_open");
    expect(resetLines(infoSpy)).toEqual([
      ["[InteractionCleanup] Cleared state: reason=test_open, interactionKind=custom, waiting=0"],
    ]);
  });
});

describe("interactionManager waiting request", () => {
  const QUESTIONS: Question[] = [
    { header: "Q", question: "Pick", options: [{ label: "A", description: "first" }] },
  ];

  function permission(id: string): PermissionRequest {
    return {
      id,
      sessionID: "session-1",
      permission: "bash",
      patterns: [id],
      metadata: {},
      always: [],
    };
  }

  function startPoll(): void {
    questionManager.startQuestions(QUESTIONS, "req-1", "session-1");
  }

  async function nextTick(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("releases the waiting request to the listener when the agent request is cleared", async () => {
    const listener = vi.fn();
    interactionManager.setOnWaitingRequestReady(listener);
    startPoll();
    interactionManager.waitPermission(permission("perm-1"));
    interactionManager.waitPermission(permission("perm-2"));
    interactionManager.waitPermission(permission("perm-1"));

    interactionManager.clear("question_completed");

    expect(listener).not.toHaveBeenCalled();
    await nextTick();
    expect(listener).toHaveBeenCalledWith(
      { kind: "permission", requests: [permission("perm-1"), permission("perm-2")] },
      0,
    );
    expect(interactionManager.getWaitingKind()).toBeNull();
  });

  it("does not release the waiting request when the slot is replaced", async () => {
    const listener = vi.fn();
    interactionManager.setOnWaitingRequestReady(listener);
    startPoll();
    interactionManager.waitPermission(permission("perm-1"));

    questionManager.startQuestions(QUESTIONS, "req-2", "session-1");
    await nextTick();

    expect(listener).not.toHaveBeenCalled();
    expect(questionManager.getRequestID()).toBe("req-2");
    expect(interactionManager.getWaitingKind()).toBe("permission");
  });

  it("does not release anything when a user flow is cleared", async () => {
    const listener = vi.fn();
    interactionManager.setOnWaitingRequestReady(listener);
    interactionManager.start({ kind: "inline", expectedInput: "callback" });

    interactionManager.clear("inline_closed");
    await nextTick();

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps only the latest waiting poll", async () => {
    const listener = vi.fn();
    interactionManager.setOnWaitingRequestReady(listener);
    permissionManager.startPermission(permission("perm-1"), 101);
    interactionManager.waitQuestion(QUESTIONS, "req-old", "session-1");
    interactionManager.waitQuestion(QUESTIONS, "req-new", "session-1");

    interactionManager.clearKind("permission", "permission_replied");
    await nextTick();

    expect(listener).toHaveBeenCalledWith(
      { kind: "question", questions: QUESTIONS, requestID: "req-new", sessionId: "session-1" },
      0,
    );
  });

  it("drops waiting permissions by request id and waiting polls on demand", () => {
    startPoll();
    interactionManager.waitPermission(permission("perm-1"));
    interactionManager.waitPermission(permission("perm-2"));

    permissionManager.settleRequest("perm-1", null);
    expect(interactionManager.getWaitingKind()).toBe("permission");
    permissionManager.settleRequest("perm-2", null);
    expect(interactionManager.getWaitingKind()).toBeNull();

    interactionManager.clear("question_completed");
    permissionManager.startPermission(permission("perm-3"), 103);
    interactionManager.waitQuestion(QUESTIONS, "req-1", "session-1");
    expect(interactionManager.dropWaitingQuestion("req-other")).toBe(false);
    expect(interactionManager.dropWaitingQuestion("req-1")).toBe(true);
    expect(interactionManager.getWaitingKind()).toBeNull();
  });

  it("releases waiting requests one at a time in the order they arrived", async () => {
    // The listener shows what it gets, so the slot is taken until it is cleared again.
    const listener = vi.fn((request: WaitingAgentRequest) => {
      if (request.kind === "question") {
        questionManager.startQuestions(request.questions, request.requestID, request.sessionId);
      } else {
        permissionManager.startPermission(defined(request.requests[0]), 101);
      }
    });
    interactionManager.setOnWaitingRequestReady(listener);
    startPoll();
    interactionManager.waitPermission(permission("perm-1"));
    interactionManager.waitQuestion(QUESTIONS, "req-b", "session-b");
    interactionManager.waitPermission(permission("perm-2"));
    interactionManager.waitQuestion(QUESTIONS, "req-c", "session-c");

    interactionManager.clear("question_completed");
    await nextTick();
    expect(listener).toHaveBeenLastCalledWith(
      { kind: "permission", requests: [permission("perm-1")] },
      0,
    );

    interactionManager.clearKind("permission", "permission_replied");
    await nextTick();
    expect(listener).toHaveBeenLastCalledWith(
      { kind: "question", questions: QUESTIONS, requestID: "req-b", sessionId: "session-b" },
      0,
    );

    interactionManager.clear("question_completed");
    await nextTick();
    expect(listener).toHaveBeenLastCalledWith(
      { kind: "permission", requests: [permission("perm-2")] },
      0,
    );
    expect(interactionManager.getWaitingQuestionRequestIds()).toEqual(["req-c"]);
  });

  it("replaces a waiting poll of the same session in its place", () => {
    startPoll();
    interactionManager.waitQuestion(QUESTIONS, "req-b-old", "session-b");
    interactionManager.waitQuestion(QUESTIONS, "req-c", "session-c");
    interactionManager.waitQuestion(QUESTIONS, "req-b-new", "session-b");

    expect(interactionManager.getWaitingQuestionRequestIds()).toEqual(["req-b-new", "req-c"]);
  });

  it("puts a released request that has to wait again back at the head", () => {
    startPoll();
    interactionManager.waitQuestion(QUESTIONS, "req-c", "session-c");
    interactionManager.waitQuestion(QUESTIONS, "req-b", "session-b", { atHead: true });
    interactionManager.waitPermission(permission("perm-1"), { atHead: true });

    expect(interactionManager.getWaitingKind()).toBe("permission");
    expect(interactionManager.getWaitingQuestionRequestIds()).toEqual(["req-b", "req-c"]);
  });

  it("releases the next request when a released one was not shown", async () => {
    const listener = vi.fn();
    interactionManager.setOnWaitingRequestReady(listener);
    startPoll();
    interactionManager.waitQuestion(QUESTIONS, "req-b", "session-b");
    interactionManager.waitQuestion(QUESTIONS, "req-c", "session-c");

    interactionManager.clear("question_completed");
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(2);
    });
    expect(listener.mock.calls.map(([request]) => request.requestID)).toEqual(["req-b", "req-c"]);
  });

  it("counts a released request as waiting until it has been presented", async () => {
    let finishPresenting: () => void = () => {};
    interactionManager.setOnWaitingRequestReady(
      () =>
        new Promise<void>((resolve) => {
          finishPresenting = resolve;
        }),
    );
    startPoll();
    interactionManager.waitQuestion(QUESTIONS, "req-b", "session-b");

    interactionManager.clear("question_completed");
    await nextTick();
    expect(interactionManager.isWaitingQuestion("req-b")).toBe(false);
    expect(interactionManager.isWaitingOrReleasing("req-b")).toBe(true);

    finishPresenting();
    await vi.waitFor(() => {
      expect(interactionManager.isWaitingOrReleasing("req-b")).toBe(false);
    });
  });

  it("releases the next request only while the slot is empty", async () => {
    const listener = vi.fn();
    interactionManager.setOnWaitingRequestReady(listener);
    startPoll();
    interactionManager.waitQuestion(QUESTIONS, "req-b", "session-b");

    interactionManager.releaseNext();
    await nextTick();
    expect(listener).not.toHaveBeenCalled();

    interactionManager.reset("test_reset");
    interactionManager.waitQuestion(QUESTIONS, "req-c", "session-c");
    interactionManager.releaseNext();
    await nextTick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops the whole queue on a reset", () => {
    startPoll();
    interactionManager.waitPermission(permission("perm-1"));
    interactionManager.waitQuestion(QUESTIONS, "req-b", "session-b");

    interactionManager.reset("abort_command");

    expect(interactionManager.getWaitingKind()).toBeNull();
    expect(interactionManager.getWaitingQuestionRequestIds()).toEqual([]);
  });

  it("drops waiting permissions and polls of one session", () => {
    startPoll();
    interactionManager.waitPermission(permission("perm-1"));
    interactionManager.waitQuestion(QUESTIONS, "req-b", "session-b");
    interactionManager.waitPermission({ ...permission("perm-2"), sessionID: "session-b" });

    interactionManager.dropWaitingPermissionsForSession("session-1");
    interactionManager.dropWaitingQuestionsForSession("session-b");

    expect(interactionManager.getWaitingPermissionRequestIds()).toEqual(["perm-2"]);
    expect(interactionManager.getWaitingQuestionRequestIds()).toEqual([]);
  });

  it("reports permission prompts still on screen when their slot is dropped", () => {
    const listener = vi.fn();
    interactionManager.setOnPermissionPromptsDropped(listener);

    permissionManager.startPermission(permission("perm-1"), 101);
    permissionManager.endPrompt(101, { kind: "replied", reply: "once", outside: false });
    interactionManager.clearKind("permission", "permission_replied");
    expect(listener).not.toHaveBeenCalled();

    permissionManager.startPermission(permission("perm-2"), 102);
    interactionManager.reset("abort_command");
    expect(listener).toHaveBeenCalledTimes(1);
    expect([...listener.mock.calls[0]![0].requestsByMessageId.keys()]).toEqual([102]);
  });

  it("reports a poll dropped by a reset or an error cleanup, not by its own close", () => {
    const listener = vi.fn();
    interactionManager.setOnQuestionDropped(listener);

    startPoll();
    questionManager.clear();
    expect(listener).not.toHaveBeenCalled();

    startPoll();
    interactionManager.clearErrorScope("question", "question_handler_error");
    expect(listener).toHaveBeenCalledTimes(1);

    startPoll();
    interactionManager.reset("abort_command");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]![0].sessionId).toBe("session-1");

    permissionManager.startPermission(permission("perm-1"), 101);
    interactionManager.reset("abort_command");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("tells the reset listener about every reset, an empty slot included", () => {
    const listener = vi.fn();
    interactionManager.setOnReset(listener);

    interactionManager.reset("abort_command");
    startPoll();
    interactionManager.reset("session_created");
    interactionManager.clearErrorScope("interaction", "bot_unhandled_error");

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clearKind leaves another kind in place", () => {
    startPoll();

    interactionManager.clearKind("permission", "permission_replied");
    renameManager.clear();
    taskCreationManager.clear();

    expect(questionManager.isActive()).toBe(true);
  });
});

describe("stateful managers on the shared slot", () => {
  const QUESTIONS: Question[] = [
    { header: "Q", question: "Pick", options: [{ label: "A", description: "first" }] },
  ];
  const PERMISSION: PermissionRequest = {
    id: "perm-1",
    sessionID: "session-1",
    permission: "bash",
    patterns: ["npm test"],
    metadata: {},
    always: [],
  };

  it("refuses to start a poll while permissions are on screen", () => {
    permissionManager.startPermission(PERMISSION, 101);

    expect(questionManager.startQuestions(QUESTIONS, "req-1", "session-1")).toBe(false);
    expect(questionManager.isActive()).toBe(false);
    expect(permissionManager.getPendingCount()).toBe(1);
  });

  it("refuses to register a permission while a poll is on screen", () => {
    questionManager.startQuestions(QUESTIONS, "req-1", "session-1");

    expect(permissionManager.startPermission(PERMISSION, 101)).toBe("question_active");
    expect(permissionManager.isActive()).toBe(false);
    expect(questionManager.isActive()).toBe(true);
  });

  it("reports a stale or resolved request before a poll on screen", () => {
    questionManager.startQuestions(QUESTIONS, "req-1", "session-1");
    const generation = permissionManager.getGeneration();

    permissionManager.settleRequest("perm-1", null);
    expect(permissionManager.startPermission(PERMISSION, 101)).toBe("resolved");

    interactionManager.bumpGeneration();
    expect(permissionManager.startPermission({ ...PERMISSION, id: "perm-2" }, 102, generation)).toBe(
      "stale",
    );
  });

  it("lets an agent request preempt a user flow", () => {
    renameManager.startWaiting("session-1", "D:/repo", "Old title");

    expect(permissionManager.startPermission(PERMISSION, 101)).toBe("started");
    expect(renameManager.isWaitingForName()).toBe(false);
    expect(interactionManager.getSnapshot()?.kind).toBe("permission");
  });

  it("does not bump the generation when the last permission ends normally", () => {
    permissionManager.startPermission(PERMISSION, 101);
    const generation = permissionManager.getGeneration();

    permissionManager.endPrompt(101, { kind: "replied", reply: "once", outside: false });
    interactionManager.clearKind("permission", "permission_replied");

    expect(permissionManager.getGeneration()).toBe(generation);

    permissionManager.startPermission(PERMISSION, 102);
    permissionManager.clear();
    expect(permissionManager.getGeneration()).toBe(generation + 1);
  });

  it("forgets resolved ids after a reset", () => {
    permissionManager.settleRequest("perm-1", null);
    expect(permissionManager.isResolved("perm-1")).toBe(true);

    interactionManager.reset("test_reset");

    expect(permissionManager.isResolved("perm-1")).toBe(false);
  });

  it("keeps task creation data in the slot", () => {
    taskCreationManager.start("project-1", "D:/repo", { providerID: "p", modelID: "m", variant: null }, "build");
    taskCreationManager.markScheduleParsing();

    expect(taskCreationManager.isParsingSchedule()).toBe(true);
    expect(interactionManager.getSnapshot()?.kind).toBe("task");

    questionManager.startQuestions(QUESTIONS, "req-1", "session-1");

    expect(taskCreationManager.isActive()).toBe(false);
    expect(taskCreationManager.getState()).toBeNull();
  });
});

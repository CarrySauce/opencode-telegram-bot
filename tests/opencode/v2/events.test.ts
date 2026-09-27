import { describe, expect, it, vi } from "vitest";
import type { OpenCodeEvent } from "@opencode/client";
import { createV2EventTranslator } from "../../../src/opencode/v2/events.js";

const DIRECTORY = "D:/repo";
const SESSION = "ses-1";
const MESSAGE = "msg-a";

function event(type: string, data: Record<string, unknown>, located = true): OpenCodeEvent {
  return {
    id: `evt-${type}`,
    created: 1000,
    type,
    data,
    ...(located ? { location: { directory: DIRECTORY } } : {}),
  } as unknown as OpenCodeEvent;
}

function payloads(translate: ReturnType<typeof createV2EventTranslator>, events: OpenCodeEvent[]) {
  return events.flatMap((item) => translate(item)).map((envelope) => envelope.payload);
}

describe("opencode/v2/events", () => {
  it("marks the idle of an interrupted execution and only that one", () => {
    const translate = createV2EventTranslator();

    const [interrupted, succeeded, failed] = [
      "session.execution.interrupted",
      "session.execution.succeeded",
      "session.execution.failed",
    ].map((type) =>
      payloads(translate, [
        event(
          type,
          type === "session.execution.failed"
            ? { sessionID: SESSION, error: { type: "unknown", message: "boom" } }
            : { sessionID: SESSION },
          false,
        ),
      ]).find((item) => item.type === "session.idle"),
    );

    expect(interrupted?.properties).toEqual({ sessionID: SESSION, interrupted: true });
    expect(succeeded?.properties).toEqual({ sessionID: SESSION });
    expect(failed?.properties).toEqual({ sessionID: SESSION });
  });

  it("turns a streamed V2 reply into the V1 message and part events", () => {
    const translate = createV2EventTranslator();

    const result = payloads(translate, [
      event("session.execution.started", { sessionID: SESSION }, false),
      event("session.step.started", {
        sessionID: SESSION,
        assistantMessageID: MESSAGE,
        agent: "build",
        model: { id: "m", providerID: "p" },
        started: 900,
      }),
      event("session.text.started", {
        sessionID: SESSION,
        assistantMessageID: MESSAGE,
        ordinal: 0,
      }),
      event("session.text.delta", {
        sessionID: SESSION,
        assistantMessageID: MESSAGE,
        ordinal: 0,
        delta: "DO",
      }),
      event("session.text.ended", {
        sessionID: SESSION,
        assistantMessageID: MESSAGE,
        ordinal: 0,
        text: "DONE",
      }),
      event("session.step.ended", {
        sessionID: SESSION,
        assistantMessageID: MESSAGE,
        finish: "stop",
        cost: 0.1,
        tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 2, write: 0 } },
      }),
      event("session.execution.succeeded", { sessionID: SESSION }, false),
    ]);

    expect(result.map((item) => item.type)).toEqual([
      "session.status",
      "message.updated",
      "message.part.updated",
      "message.part.updated",
      "message.part.delta",
      "message.part.updated",
      "message.part.updated",
      "message.updated",
      "session.status",
      "session.idle",
    ]);
    expect(result[0]).toMatchObject({ properties: { status: { type: "busy" } } });
    expect(result[1]).toMatchObject({
      properties: { info: { id: MESSAGE, role: "assistant", agent: "build", providerID: "p" } },
    });
    expect(result[4]).toMatchObject({
      properties: { messageID: MESSAGE, partID: `${MESSAGE}:text:0`, delta: "DO" },
    });
    expect(result[5]).toMatchObject({ properties: { part: { type: "text", text: "DONE" } } });
    expect(result[7]).toMatchObject({
      properties: { info: { time: { completed: 1000 }, cost: 0.1, tokens: { input: 5 } } },
    });
  });

  it("follows a tool call from input to result under its V1 name", () => {
    const translate = createV2EventTranslator();
    const base = { sessionID: SESSION, assistantMessageID: MESSAGE, id: "call-1" };

    const result = payloads(translate, [
      event("session.tool.input.started", { ...base, name: "read" }),
      event("session.tool.called", { ...base, input: { path: "a.txt" }, executed: false }),
      event("session.tool.success", {
        ...base,
        content: [{ type: "text", text: "1: hello" }],
        metadata: { truncated: false },
        executed: false,
      }),
    ]);

    expect(
      result.map(
        (item) => (item.properties as { part: { state: { status: string } } }).part.state.status,
      ),
    ).toEqual(["pending", "running", "completed"]);
    expect(result[2]).toMatchObject({
      properties: {
        part: {
          type: "tool",
          tool: "read",
          callID: "call-1",
          state: { input: { filePath: "a.txt" }, output: "1: hello" },
        },
      },
    });
  });

  it("reports a failed run as a session error followed by idle", () => {
    const translate = createV2EventTranslator();

    const result = payloads(translate, [
      event(
        "session.execution.failed",
        { sessionID: SESSION, error: { type: "provider.no-route", message: "Model unavailable" } },
        false,
      ),
    ]);

    expect(result.map((item) => item.type)).toEqual([
      "session.error",
      "session.status",
      "session.idle",
    ]);
    expect(result[0]).toMatchObject({
      properties: { sessionID: SESSION, error: { data: { message: "Model unavailable" } } },
    });
  });

  it("shows a delivered prompt as a V1 user message", () => {
    const translate = createV2EventTranslator();

    const result = payloads(translate, [
      event("session.inbox.enqueued", {
        sessionID: SESSION,
        inboxID: "msg-user",
        item: { type: "user", payload: { text: "hello" }, delivery: "queue" },
      }),
      event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg-user" }),
    ]);

    expect(result.map((item) => item.type)).toEqual(["message.updated", "message.part.updated"]);
    expect(result[0]).toMatchObject({ properties: { info: { id: "msg-user", role: "user" } } });
    expect(result[1]).toMatchObject({ properties: { part: { text: "hello" } } });
  });

  it("turns V2 permissions and forms into V1 permission and question events", () => {
    const onForm = vi.fn();
    const translate = createV2EventTranslator({ onForm });
    const form = {
      id: "form-1",
      sessionID: SESSION,
      title: "Continue?",
      fields: [{ key: "go", type: "boolean" }],
    };

    const result = payloads(translate, [
      event("permission.asked", {
        id: "perm-1",
        sessionID: SESSION,
        action: "shell",
        resources: ["npm test"],
        save: ["npm *"],
      }),
      event("permission.replied", { sessionID: SESSION, requestID: "perm-1", reply: "always" }),
      event("form.created", { form }),
      event("form.cancelled", { id: "form-1", sessionID: SESSION }),
    ]);

    expect(result[0]).toMatchObject({
      type: "permission.asked",
      properties: { id: "perm-1", permission: "shell", patterns: ["npm test"], always: ["npm *"] },
    });
    expect(result[1]).toMatchObject({
      type: "permission.replied",
      properties: { requestID: "perm-1", reply: "always" },
    });
    expect(result[2]).toMatchObject({ type: "question.asked", properties: { id: "form-1" } });
    expect(onForm).toHaveBeenCalledWith(form);
    expect(result[3]).toMatchObject({
      type: "question.rejected",
      properties: { requestID: "form-1" },
    });
  });

  it("carries the session directory onto events that arrive without a location", () => {
    const translate = createV2EventTranslator();
    translate(
      event("session.created", {
        sessionID: SESSION,
        projectID: "project",
        location: { directory: DIRECTORY },
        slug: "s",
        parentID: "ses-parent",
        version: "2",
      }),
    );

    const [envelope] = translate(event("session.execution.started", { sessionID: SESSION }, false));

    expect(envelope?.directory).toBe(DIRECTORY);
  });

  it("keeps each subscription's partial state to itself", () => {
    const first = createV2EventTranslator();
    first(
      event("session.tool.input.started", {
        sessionID: SESSION,
        assistantMessageID: MESSAGE,
        id: "call-1",
        name: "shell",
      }),
    );

    const second = createV2EventTranslator();
    const [envelope] = second(
      event("session.tool.called", {
        sessionID: SESSION,
        assistantMessageID: MESSAGE,
        id: "call-1",
        input: { command: "ls" },
        executed: false,
      }),
    );

    expect(envelope?.payload).toMatchObject({ properties: { part: { tool: "unknown" } } });
  });

  describe("background operations", () => {
    const base = { sessionID: SESSION, assistantMessageID: MESSAGE, id: "call-bg" };

    function toolStates(result: ReturnType<typeof payloads>) {
      return result
        .filter((item) => item.type === "message.part.updated")
        .map((item) => (item.properties as { part: { state: Record<string, unknown> } }).part.state);
    }

    function launchShell(translate: ReturnType<typeof createV2EventTranslator>) {
      return payloads(translate, [
        event("session.tool.input.started", { ...base, name: "shell" }),
        event("session.tool.called", {
          ...base,
          input: { command: "sleep 90", background: true },
          executed: false,
        }),
        event("session.tool.success", {
          ...base,
          content: [{ type: "text", text: "Command moved to the background" }],
          metadata: { shellID: "sh-1", status: "running" },
          executed: false,
        }),
      ]);
    }

    it("keeps a background command running when V2 reports it done at launch", () => {
      const translate = createV2EventTranslator();

      const states = toolStates(launchShell(translate));

      expect(states.map((state) => state.status)).toEqual(["pending", "running", "running"]);
      expect(states[2]).toMatchObject({
        input: { command: "sleep 90", background: true },
        metadata: { shellID: "sh-1", status: "running" },
      });
    });

    it("completes the background command when its shell exits", () => {
      const translate = createV2EventTranslator();
      launchShell(translate);

      const result = payloads(translate, [
        event("shell.exited", { id: "sh-other", exit: 0, status: "exited" }),
        event("shell.exited", { id: "sh-1", exit: 0, status: "exited" }),
        event("shell.exited", { id: "sh-1", exit: 0, status: "exited" }),
      ]);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        properties: {
          part: {
            callID: "call-bg",
            tool: "bash",
            sessionID: SESSION,
            messageID: MESSAGE,
            state: {
              status: "completed",
              output: "Command moved to the background",
              metadata: { shellID: "sh-1", status: "exited", exit: 0 },
              time: { start: 1000, end: 1000 },
            },
          },
        },
      });
    });

    it("leaves a command that finished before its success as an ordinary completion", () => {
      const translate = createV2EventTranslator();

      const result = payloads(translate, [
        event("session.tool.input.started", { ...base, name: "shell" }),
        event("session.tool.success", {
          ...base,
          content: [],
          metadata: { shellID: "sh-1", status: "completed" },
          executed: false,
        }),
      ]);

      expect(toolStates(result).map((state) => state.status)).toEqual(["pending", "completed"]);
    });

    function launchSubagent(translate: ReturnType<typeof createV2EventTranslator>) {
      return payloads(translate, [
        event("session.tool.input.started", { ...base, name: "subagent" }),
        event("session.tool.called", {
          ...base,
          input: { description: "Scan", agent: "general", background: true },
          executed: false,
        }),
        event("session.tool.success", {
          ...base,
          content: [{ type: "text", text: "The subagent is working in the background" }],
          metadata: { sessionID: "child-1", status: "running" },
          executed: false,
        }),
      ]);
    }

    it("keeps a background subagent's task running and names its child session", () => {
      const translate = createV2EventTranslator();

      const states = toolStates(launchSubagent(translate));

      expect(states[2]).toMatchObject({
        status: "running",
        input: { background: true },
        metadata: { sessionID: "child-1", sessionId: "child-1" },
      });
    });

    it("completes the parent's task after the child session ends", () => {
      const translate = createV2EventTranslator();
      launchSubagent(translate);

      const result = payloads(translate, [
        event("session.execution.succeeded", { sessionID: "child-1" }, false),
      ]);

      expect(result.map((item) => item.type)).toEqual([
        "session.status",
        "session.idle",
        "message.part.updated",
      ]);
      expect(result[1]).toMatchObject({ properties: { sessionID: "child-1" } });
      expect(result[2]).toMatchObject({
        properties: {
          part: { callID: "call-bg", tool: "task", sessionID: SESSION, state: { status: "completed" } },
        },
      });
    });

    it("fails the parent's task when the child session fails", () => {
      const translate = createV2EventTranslator();
      launchSubagent(translate);

      const result = payloads(translate, [
        event(
          "session.execution.failed",
          { sessionID: "child-1", error: { type: "unknown", message: "boom" } },
          false,
        ),
      ]);

      expect(result.at(-1)).toMatchObject({
        properties: { part: { callID: "call-bg", state: { status: "error", error: "boom" } } },
      });
    });
  });
});

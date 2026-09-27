import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { createTestAppContainer } from "../../helpers/app-container.js";
import { startInteractionForTest } from "../../helpers/interaction.js";
import type { AppContainer } from "../../../src/app/bootstrap/app-container.js";

const mocked = vi.hoisted(() => ({
  reloadKnown: true,
}));

vi.mock("../../../src/bot/routers/command-utils.js", () => ({
  isKnownCommand: (command: string) => command === "reload" && mocked.reloadKnown,
}));

import { resolveInteractionGuardDecision } from "../../../src/bot/middleware/interaction-guard-decision.js";

let deps: AppContainer;

function reloadContext(): Context {
  return { message: { text: "/reload" } } as unknown as Context;
}

describe("interaction guard: /reload", () => {
  beforeEach(() => {
    mocked.reloadKnown = true;
    deps = createTestAppContainer();
    deps.interactionManager.clear("test_setup");
  });

  it("allows /reload while a task runs and nothing is on screen", () => {
    deps.foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    const decision = resolveInteractionGuardDecision(reloadContext(), deps);

    expect(decision.allow).toBe(true);
    expect(decision.busy).toBe(true);
  });

  it("blocks /reload while a task runs and a question is on screen", () => {
    deps.foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");
    startInteractionForTest(deps.interactionManager, {
      kind: "question",
      expectedInput: "mixed",
    });

    const decision = resolveInteractionGuardDecision(reloadContext(), deps);

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("command_not_allowed");
  });

  it("blocks /reload while an inline menu is on screen and nothing runs", () => {
    startInteractionForTest(deps.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
    });

    const decision = resolveInteractionGuardDecision(reloadContext(), deps);

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("command_not_allowed");
  });

  it("keeps the busy block for /reload when the server version has no such command", () => {
    mocked.reloadKnown = false;
    deps.foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    const decision = resolveInteractionGuardDecision(reloadContext(), deps);

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("command_not_allowed");
    expect(decision.busy).toBe(true);
  });
});

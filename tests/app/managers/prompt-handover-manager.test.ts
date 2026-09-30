import { beforeEach, describe, expect, it } from "vitest";
import { promptHandover } from "../../../src/app/managers/prompt-handover-manager.js";
import { createIncomingPrompt } from "../../../src/app/types/prompt.js";

const SESSION = { id: "ses-1", directory: "D:/repo" };
const SELECTION = { agent: "build", providerID: "p", modelID: "m", variant: "high" };

function handedOver(text: string) {
  return { ...createIncomingPrompt(text), selection: SELECTION };
}

describe("app/managers/prompt-handover-manager", () => {
  beforeEach(() => {
    promptHandover.__resetForTests();
  });

  it("accepts nothing for a session that was never detached", () => {
    expect(promptHandover.addPrompt("ses-1", handedOver("lost"))).toBe(false);
    expect(
      promptHandover.addInboxEntry({ sessionId: "ses-1", inboxId: "msg-1", delivery: "steer" }),
    ).toBe(false);
    expect(promptHandover.hasPendingPrompts("ses-1")).toBe(false);
  });

  it("keeps the prompts of a detached session in order until taken", () => {
    promptHandover.recordDetach(SESSION, SELECTION);
    promptHandover.addPrompt("ses-1", handedOver("first"));
    promptHandover.addPrompt("ses-1", handedOver("second"));

    expect(promptHandover.takeNextPrompt("ses-1")?.text).toBe("first");
    expect(promptHandover.hasPendingPrompts("ses-1")).toBe(true);
    expect(promptHandover.takeNextPrompt("ses-1")?.text).toBe("second");
    expect(promptHandover.hasPendingPrompts("ses-1")).toBe(false);
  });

  it("counts a sent prompt as pending until its turn is over", () => {
    promptHandover.recordDetach(SESSION, SELECTION);

    promptHandover.setTurnInFlight("ses-1", true);
    expect(promptHandover.hasPendingPrompts("ses-1")).toBe(true);

    promptHandover.setTurnInFlight("ses-1", false);
    expect(promptHandover.hasPendingPrompts("ses-1")).toBe(false);
  });

  it("follows a ticket to its session only when that session was detached after it", () => {
    const before = promptHandover.takeTicket("ses-1");
    promptHandover.recordDetach(SESSION, SELECTION);
    const after = promptHandover.takeTicket("ses-1");

    expect(promptHandover.wasDetachedSince(before)).toBe(true);
    expect(promptHandover.wasDetachedSince(after)).toBe(false);
    expect(promptHandover.wasDetachedSince({ sessionId: "ses-2", detachSeq: 0 })).toBe(false);
  });

  it("forgets an inbox entry once OpenCode picked it up", () => {
    promptHandover.recordDetach(SESSION, SELECTION);
    promptHandover.addInboxEntry({ sessionId: "ses-1", inboxId: "msg-1", delivery: "steer" });
    promptHandover.addInboxEntry({ sessionId: "ses-1", inboxId: "msg-2", delivery: "steer" });

    promptHandover.forgetInboxId("msg-1");

    expect(promptHandover.withdraw("ses-1", "abort_command")).toEqual([
      { sessionId: "ses-1", inboxId: "msg-2", delivery: "steer" },
    ]);
  });

  it("withdraws one session and leaves the others", () => {
    promptHandover.recordDetach(SESSION, SELECTION);
    promptHandover.recordDetach({ id: "ses-2", directory: "D:/other" }, SELECTION);
    promptHandover.addPrompt("ses-1", handedOver("one"));
    promptHandover.addPrompt("ses-2", handedOver("two"));

    promptHandover.withdraw("ses-1", "abort_command");

    expect(promptHandover.get("ses-1")).toBeNull();
    expect(promptHandover.hasPendingPrompts("ses-2")).toBe(true);
  });

  it("withdraws every session and returns all their inbox entries", () => {
    promptHandover.recordDetach(SESSION, SELECTION);
    promptHandover.recordDetach({ id: "ses-2", directory: "D:/other" }, SELECTION);
    promptHandover.addInboxEntry({ sessionId: "ses-1", inboxId: "msg-1", delivery: "steer" });
    promptHandover.addInboxEntry({ sessionId: "ses-2", inboxId: "msg-2", delivery: "queue" });

    const withdrawn = promptHandover.withdrawAll("opencode_stop");

    expect(withdrawn.map((entry) => entry.inboxId)).toEqual(["msg-1", "msg-2"]);
    expect(promptHandover.get("ses-1")).toBeNull();
    expect(promptHandover.get("ses-2")).toBeNull();
  });

  it("keeps earlier prompts when the same session is detached again", () => {
    promptHandover.recordDetach(SESSION, SELECTION);
    promptHandover.addPrompt("ses-1", handedOver("first"));

    promptHandover.recordDetach(SESSION, { ...SELECTION, modelID: "other" });

    expect(promptHandover.get("ses-1")?.selection.modelID).toBe("other");
    expect(promptHandover.takeNextPrompt("ses-1")?.selection.modelID).toBe("m");
  });
});

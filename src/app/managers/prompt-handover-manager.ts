import { logger } from "../../utils/logger.js";
import type { IncomingPrompt } from "../types/prompt.js";
import type { QueuedPromptInbox } from "./prompt-queue-manager.js";

/** Agent, model and variant the chat had when the session was detached. */
export interface HandoverSelection {
  agent: string | undefined;
  providerID: string;
  modelID: string;
  variant?: string | undefined;
}

/** A V1 prompt the bot still holds for a detached session. */
export interface HandedOverPrompt extends IncomingPrompt {
  selection: HandoverSelection;
}

/** What waits for one session the bot was detached from. */
export interface SessionHandover {
  sessionId: string;
  directory: string;
  selection: HandoverSelection;
  prompts: HandedOverPrompt[];
  inboxEntries: QueuedPromptInbox[];
  detachSeq: number;
  turnInFlight: boolean;
}

/** The busy session a message arrived for, taken before the message is prepared. */
export interface ArrivalTicket {
  sessionId: string;
  detachSeq: number;
}

/**
 * Prompt Handover - messages that waited for a running turn when the bot was detached
 * from the session. They are no longer the chat's queue: no buttons, no cap, and session
 * switches do not withdraw them. Only /abort in that session and /opencode_stop do.
 * Kept in memory only, like the prompt queue.
 * Singleton pattern
 */
class PromptHandoverManager {
  private sessions = new Map<string, SessionHandover>();
  private detachSeq = 0;

  /** Records a detach from the session; later messages prepared for it follow it there. */
  recordDetach(
    session: { id: string; directory: string },
    selection: HandoverSelection,
  ): SessionHandover {
    this.detachSeq += 1;
    const existing = this.sessions.get(session.id);
    if (existing) {
      existing.directory = session.directory;
      existing.selection = { ...selection };
      existing.detachSeq = this.detachSeq;
      return existing;
    }

    const record: SessionHandover = {
      sessionId: session.id,
      directory: session.directory,
      selection: { ...selection },
      prompts: [],
      inboxEntries: [],
      detachSeq: this.detachSeq,
      turnInFlight: false,
    };
    this.sessions.set(session.id, record);
    return record;
  }

  get(sessionId: string): SessionHandover | null {
    return this.sessions.get(sessionId) ?? null;
  }

  takeTicket(sessionId: string): ArrivalTicket {
    return { sessionId, detachSeq: this.detachSeq };
  }

  /** Whether the ticket's session was detached after the message arrived. */
  wasDetachedSince(ticket: ArrivalTicket): boolean {
    const record = this.sessions.get(ticket.sessionId);
    return Boolean(record && record.detachSeq > ticket.detachSeq);
  }

  addPrompt(sessionId: string, prompt: HandedOverPrompt): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return false;
    }
    record.prompts.push(prompt);
    logger.debug(
      `[PromptHandover] Prompt handed over: session=${sessionId}, size=${record.prompts.length}`,
    );
    return true;
  }

  addInboxEntry(inbox: QueuedPromptInbox): boolean {
    const record = this.sessions.get(inbox.sessionId);
    if (!record) {
      return false;
    }
    record.inboxEntries.push({ ...inbox });
    logger.debug(
      `[PromptHandover] Inbox prompt handed over: session=${inbox.sessionId}, inboxId=${inbox.inboxId}`,
    );
    return true;
  }

  takeNextPrompt(sessionId: string): HandedOverPrompt | null {
    return this.sessions.get(sessionId)?.prompts.shift() ?? null;
  }

  setTurnInFlight(sessionId: string, inFlight: boolean): void {
    const record = this.sessions.get(sessionId);
    if (record) {
      record.turnInFlight = inFlight;
    }
  }

  /** Whether V1 prompts handed over to the session are still to be sent or answered. */
  hasPendingPrompts(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    return Boolean(record && (record.prompts.length > 0 || record.turnInFlight));
  }

  /** OpenCode picked the prompt up: it can no longer be withdrawn. */
  forgetInboxId(inboxId: string): void {
    for (const record of this.sessions.values()) {
      record.inboxEntries = record.inboxEntries.filter((entry) => entry.inboxId !== inboxId);
    }
  }

  /** Drops everything handed over to the session; returns the inbox entries to cancel. */
  withdraw(sessionId: string, reason: string): QueuedPromptInbox[] {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return [];
    }
    this.sessions.delete(sessionId);
    logger.info(
      `[PromptHandover] Withdrew handed-over prompts: session=${sessionId}, reason=${reason}, prompts=${record.prompts.length}, inbox=${record.inboxEntries.length}`,
    );
    return record.inboxEntries;
  }

  withdrawAll(reason: string): QueuedPromptInbox[] {
    return [...this.sessions.keys()].flatMap((sessionId) => this.withdraw(sessionId, reason));
  }

  __resetForTests(): void {
    this.sessions.clear();
    this.detachSeq = 0;
  }
}

export const promptHandover = new PromptHandoverManager();

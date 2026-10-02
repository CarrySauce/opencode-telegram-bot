import type {
  ActiveInteraction,
  DroppedPermissionPromptsListener,
  DroppedQuestionListener,
  InteractionClearReason,
  InteractionPayloads,
  InteractionResetListener,
  InteractionState,
  StartInteractionOptions,
  StatefulInteractionKind,
  TransitionInteractionOptions,
  WaitingAgentRequest,
  WaitingAgentRequestListener,
} from "../types/interaction.js";
import type { PermissionRequest } from "../types/permission.js";
import type { Question } from "../types/question.js";
import { logger } from "../../utils/logger.js";

export const DEFAULT_ALLOWED_INTERACTION_COMMANDS = [
  "/help",
  "/status",
  "/abort",
  "/detach",
  "/opencode_stop",
] as const;

function normalizeCommand(command: string): string | null {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutMention = withSlash.split("@")[0];
  if (!withoutMention || withoutMention.length <= 1) {
    return null;
  }

  return withoutMention;
}

function normalizeAllowedCommands(commands?: string[]): string[] {
  if (commands === undefined) {
    return [...DEFAULT_ALLOWED_INTERACTION_COMMANDS];
  }

  const normalized = new Set<string>();

  for (const command of commands) {
    const value = normalizeCommand(command);
    if (value) {
      normalized.add(value);
    }
  }

  return Array.from(normalized);
}

function toSnapshot(state: ActiveInteraction): InteractionState {
  return {
    kind: state.kind,
    expectedInput: state.expectedInput,
    allowedCommands: [...state.allowedCommands],
    metadata: { ...state.metadata },
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
  };
}

function isAgentRequestKind(kind: InteractionState["kind"]): boolean {
  return kind === "question" || kind === "permission";
}

export type InteractionErrorScope =
  | "question"
  | "permission"
  | "rename"
  | "taskCreation"
  | "interaction"
  | "none";

const SCOPE_TO_INTERACTION_KIND: Record<
  Exclude<InteractionErrorScope, "interaction" | "none">,
  StatefulInteractionKind
> = {
  question: "question",
  permission: "permission",
  rename: "rename",
  taskCreation: "task",
};

export class InteractionManager {
  private state: ActiveInteraction | null = null;
  // Agent requests waiting for the slot, in the order they arrived.
  private waiting: WaitingAgentRequest[] = [];
  private generation = 0;
  private onWaitingRequestReady: WaitingAgentRequestListener | null = null;
  private onPermissionPromptsDropped: DroppedPermissionPromptsListener | null = null;
  private onQuestionDropped: DroppedQuestionListener | null = null;
  private onReset: InteractionResetListener | null = null;
  // Request IDs taken out of the queue whose presentation has not finished yet.
  private releasingRequestIds = new Set<string>();

  /**
   * Opens the slot, replacing whatever it held. Replacing never releases the
   * waiting request: only a clear does.
   */
  start(options: StartInteractionOptions): InteractionState {
    const now = Date.now();
    let expiresAt: number | null = null;

    if (this.state) {
      this.drop("state_replaced");
    }

    const { expiresInMs, ...rest } = options;
    if (typeof expiresInMs === "number") {
      expiresAt = now + expiresInMs;
    }

    const nextState: ActiveInteraction = {
      ...rest,
      allowedCommands: normalizeAllowedCommands(options.allowedCommands),
      metadata: options.metadata ? { ...options.metadata } : {},
      createdAt: now,
      expiresAt,
    };

    this.state = nextState;

    logger.info(
      `[InteractionManager] Started interaction: kind=${nextState.kind}, expectedInput=${nextState.expectedInput}, allowedCommands=${nextState.allowedCommands.join(",") || "none"}`,
    );

    return toSnapshot(nextState);
  }

  get(): InteractionState | null {
    if (!this.state) {
      return null;
    }

    return toSnapshot(this.state);
  }

  getSnapshot(): InteractionState | null {
    return this.get();
  }

  /**
   * Live data of the given kind, or null when the slot holds another kind.
   */
  getPayload<K extends StatefulInteractionKind>(kind: K): InteractionPayloads[K] | null {
    if (!this.state || this.state.kind !== kind || !("payload" in this.state)) {
      return null;
    }

    return this.state.payload as InteractionPayloads[K];
  }

  isActive(): boolean {
    return this.state !== null;
  }

  isExpired(referenceTimeMs: number = Date.now()): boolean {
    if (!this.state || this.state.expiresAt === null) {
      return false;
    }

    return referenceTimeMs >= this.state.expiresAt;
  }

  transition(options: TransitionInteractionOptions): InteractionState | null {
    if (!this.state) {
      return null;
    }

    const now = Date.now();

    this.state = {
      ...this.state,
      expectedInput: options.expectedInput ?? this.state.expectedInput,
      allowedCommands:
        options.allowedCommands !== undefined
          ? normalizeAllowedCommands(options.allowedCommands)
          : [...this.state.allowedCommands],
      metadata: options.metadata ? { ...options.metadata } : { ...this.state.metadata },
      expiresAt:
        options.expiresInMs === undefined
          ? this.state.expiresAt
          : options.expiresInMs === null
            ? null
            : now + options.expiresInMs,
    };

    logger.debug(
      `[InteractionManager] Transitioned interaction: kind=${this.state.kind}, expectedInput=${this.state.expectedInput}, allowedCommands=${this.state.allowedCommands.join(",") || "none"}`,
    );

    return toSnapshot(this.state);
  }

  /**
   * Empties the slot. When a question or permission ends and an agent request is
   * waiting, the one that arrived first is handed to the listener.
   */
  clear(reason: InteractionClearReason = "manual"): void {
    const clearedKind = this.drop(reason);
    if (!clearedKind || !isAgentRequestKind(clearedKind)) {
      return;
    }

    this.releaseHead(clearedKind);
  }

  /**
   * Hands the first waiting request to the listener while the slot is empty, so a
   * released request that was not shown does not leave the rest waiting.
   */
  releaseNext(): void {
    if (this.state) {
      return;
    }

    this.releaseHead("empty_slot");
  }

  /**
   * Clears the slot only if it holds the given kind.
   */
  clearKind(kind: InteractionState["kind"], reason: InteractionClearReason): void {
    if (this.state?.kind === kind) {
      this.clear(reason);
    }
  }

  /**
   * Drops the slot and the waiting request together, and marks permission
   * prompts still being sent as stale.
   */
  reset(reason: InteractionClearReason): void {
    const interactionSnapshot = this.getSnapshot();
    const waitingCount = this.waiting.length;

    this.waiting = [];
    this.bumpGeneration();
    this.dropAndEndPoll(() => this.drop(reason));

    try {
      this.onReset?.();
    } catch (err) {
      logger.error("[InteractionManager] Error in reset listener:", err);
    }

    const message =
      `[InteractionCleanup] Cleared state: reason=${reason}, ` +
      `interactionKind=${interactionSnapshot?.kind || "none"}, waiting=${waitingCount}`;

    if (interactionSnapshot !== null || waitingCount > 0) {
      logger.info(message);
      return;
    }

    logger.debug(message);
  }

  /**
   * Drops only what a failed handler in the given scope may have left behind.
   */
  clearErrorScope(scope: InteractionErrorScope, reason: InteractionClearReason): void {
    if (scope === "none") {
      return;
    }

    const stateBefore = this.getSnapshot();

    if (scope === "interaction") {
      this.dropAndEndPoll(() => this.clear(reason));
    } else {
      if (scope === "permission") {
        // Bump first, so a poll released by this clear carries the new generation.
        this.bumpGeneration();
      }

      this.dropAndEndPoll(() => this.clearKind(SCOPE_TO_INTERACTION_KIND[scope], reason));
    }

    logger.debug(
      `[InteractionCleanup] Cleared scoped state: reason=${reason}, scope=${scope}, interactionKind=${stateBefore?.kind || "none"}`,
    );
  }

  getGeneration(): number {
    return this.generation;
  }

  bumpGeneration(): void {
    this.generation++;
  }

  /**
   * Queues a poll. A poll of a session that already waits replaces that one in its
   * place; `atHead` puts a released poll that has to wait again back in front.
   */
  waitQuestion(
    questions: Question[],
    requestID: string,
    sessionId: string,
    options: { atHead?: boolean } = {},
  ): void {
    const entry: WaitingAgentRequest = { kind: "question", questions, requestID, sessionId };
    const index = this.waiting.findIndex(
      (waiting) => waiting.kind === "question" && waiting.sessionId === sessionId,
    );

    if (index >= 0) {
      logger.info(`[InteractionManager] Replacing waiting poll of session: session=${sessionId}`);
      this.waiting[index] = entry;
    } else if (options.atHead) {
      this.waiting.unshift(entry);
    } else {
      this.waiting.push(entry);
    }

    logger.info(
      `[InteractionManager] Poll is waiting: requestID=${requestID}, waiting=${this.waiting.length}`,
    );
  }

  /**
   * Queues a permission. It joins the permission group at the end of the queue (or at
   * its head with `atHead`), or starts a new group when a poll waits in that place.
   */
  waitPermission(request: PermissionRequest, options: { atHead?: boolean } = {}): void {
    if (this.isWaitingPermission(request.id)) {
      return;
    }

    const index = options.atHead ? 0 : this.waiting.length - 1;
    const neighbour = this.waiting[index];
    if (neighbour?.kind === "permission") {
      neighbour.requests.push(request);
    } else if (options.atHead) {
      this.waiting.unshift({ kind: "permission", requests: [request] });
    } else {
      this.waiting.push({ kind: "permission", requests: [request] });
    }

    logger.info(
      `[InteractionManager] Permission is waiting: requestID=${request.id}, waiting=${this.waiting.length}`,
    );
  }

  dropWaitingPermission(requestID: string): void {
    if (this.dropWaitingPermissions((request) => request.id === requestID)) {
      logger.info(`[InteractionManager] Dropped waiting permission: requestID=${requestID}`);
    }
  }

  dropWaitingPermissionsForSession(sessionID: string): void {
    if (this.dropWaitingPermissions((request) => request.sessionID === sessionID)) {
      logger.info(
        `[InteractionManager] Dropped waiting permissions of session: session=${sessionID}`,
      );
    }
  }

  dropWaitingQuestion(requestID: string): boolean {
    return this.dropWaitingQuestions((waiting) => waiting.requestID === requestID);
  }

  dropWaitingQuestionsForSession(sessionId: string): boolean {
    return this.dropWaitingQuestions((waiting) => waiting.sessionId === sessionId);
  }

  /** Kind of the request that is released next, or null when nothing waits. */
  getWaitingKind(): WaitingAgentRequest["kind"] | null {
    return this.waiting[0]?.kind ?? null;
  }

  isWaitingQuestion(requestID: string): boolean {
    return this.getWaitingQuestionRequestIds().includes(requestID);
  }

  isWaitingPermission(requestID: string): boolean {
    return this.getWaitingPermissionRequestIds().includes(requestID);
  }

  /** Whether a request waits in the queue or was released and is still being presented. */
  isWaitingOrReleasing(requestID: string): boolean {
    return (
      this.releasingRequestIds.has(requestID) ||
      this.isWaitingQuestion(requestID) ||
      this.isWaitingPermission(requestID)
    );
  }

  getWaitingQuestionRequestIds(): string[] {
    return this.waiting.flatMap((waiting) =>
      waiting.kind === "question" ? [waiting.requestID] : [],
    );
  }

  getWaitingPermissionRequestIds(): string[] {
    return this.waiting.flatMap((waiting) =>
      waiting.kind === "permission" ? waiting.requests.map((request) => request.id) : [],
    );
  }

  setOnWaitingRequestReady(listener: WaitingAgentRequestListener | null): void {
    this.onWaitingRequestReady = listener;
  }

  setOnPermissionPromptsDropped(listener: DroppedPermissionPromptsListener | null): void {
    this.onPermissionPromptsDropped = listener;
  }

  setOnQuestionDropped(listener: DroppedQuestionListener | null): void {
    this.onQuestionDropped = listener;
  }

  setOnReset(listener: InteractionResetListener | null): void {
    this.onReset = listener;
  }

  /**
   * Runs a cleanup drop and hands a poll it removed to the listener, so the poll gets its
   * "not answered" ending instead of dead buttons. Explicit closes of a poll write their own
   * ending and do not come through here.
   */
  private dropAndEndPoll(dropSlot: () => void): void {
    const poll = this.state?.kind === "question" ? this.state.payload : null;
    dropSlot();
    if (!poll || (this.state?.kind === "question" && this.state.payload === poll)) {
      return;
    }

    try {
      this.onQuestionDropped?.(poll);
    } catch (err) {
      logger.error("[InteractionManager] Error in dropped poll listener:", err);
    }
  }

  private releaseHead(after: string): void {
    const request = this.waiting.shift();
    if (!request) {
      return;
    }

    const generation = this.generation;
    const listener = this.onWaitingRequestReady;
    if (!listener) {
      logger.warn(
        `[InteractionManager] No listener for the waiting request, dropping it: kind=${request.kind}`,
      );
      return;
    }

    logger.info(
      `[InteractionManager] Releasing waiting request: kind=${request.kind}, after=${after}, waiting=${this.waiting.length}`,
    );

    const requestIds =
      request.kind === "question" ? [request.requestID] : request.requests.map(({ id }) => id);
    for (const requestID of requestIds) {
      this.releasingRequestIds.add(requestID);
    }

    setImmediate(() => {
      void Promise.resolve()
        .then(() => listener(request, generation))
        .catch((err) => {
          logger.error(`[InteractionManager] Failed to present the waiting ${request.kind}:`, err);
        })
        .finally(() => {
          for (const requestID of requestIds) {
            this.releasingRequestIds.delete(requestID);
          }
          // A released request that was not shown must not hold back the rest of the queue.
          this.releaseNext();
        });
    });
  }

  private dropWaitingPermissions(matches: (request: PermissionRequest) => boolean): boolean {
    let dropped = false;
    this.waiting = this.waiting.flatMap((waiting): WaitingAgentRequest[] => {
      if (waiting.kind !== "permission") {
        return [waiting];
      }

      const requests = waiting.requests.filter((request) => !matches(request));
      dropped ||= requests.length !== waiting.requests.length;
      return requests.length > 0 ? [{ kind: "permission", requests }] : [];
    });
    return dropped;
  }

  private dropWaitingQuestions(
    matches: (waiting: Extract<WaitingAgentRequest, { kind: "question" }>) => boolean,
  ): boolean {
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((waiting) => {
      if (waiting.kind !== "question" || !matches(waiting)) {
        return true;
      }

      logger.info(`[InteractionManager] Dropped waiting poll: requestID=${waiting.requestID}`);
      return false;
    });
    return this.waiting.length !== before;
  }

  private drop(reason: InteractionClearReason): InteractionState["kind"] | null {
    if (!this.state) {
      return null;
    }

    const dropped = this.state;
    logger.info(
      `[InteractionManager] Cleared interaction: reason=${reason}, kind=${dropped.kind}, expectedInput=${dropped.expectedInput}`,
    );

    this.state = null;

    // Prompts still on screen get their "not answered" ending instead of dead buttons.
    if (dropped.kind === "permission" && dropped.payload.requestsByMessageId.size > 0) {
      try {
        this.onPermissionPromptsDropped?.(dropped.payload);
      } catch (err) {
        logger.error("[InteractionManager] Error in dropped permission prompts listener:", err);
      }
    }

    return dropped.kind;
  }
}

import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import {
  resolveStreamThrottleMs,
  type StreamThrottleMs,
} from "./stream-throttle.js";

interface CompactProgressState {
  sessionId: string;
  messageId: number | null;
  latestText: string;
  toolCallIds: Set<string>;
  filePaths: Set<string>;
  // Background operations started on this card, in start order, with their current text.
  backgroundActivities: Map<string, string>;
  timer: ReturnType<typeof setTimeout> | null;
  task: Promise<boolean>;
  cancelled: boolean;
  sendFailed: boolean;
}

interface HeldStretch {
  activity: string | null;
  toolCallIds: string[];
}

export interface CompactProgressStreamerOptions {
  throttleMs: StreamThrottleMs;
  sendText: (sessionId: string, text: string) => Promise<number>;
  editText: (sessionId: string, messageId: number, text: string) => Promise<void>;
  deleteText?: (sessionId: string, messageId: number) => Promise<void>;
  /** A card kept open past its close for the background operations it still shows. */
  onPark?: (sessionId: string, callIds: string[]) => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createInitialState(sessionId: string): CompactProgressState {
  return {
    sessionId,
    messageId: null,
    latestText: "",
    toolCallIds: new Set(),
    filePaths: new Set(),
    backgroundActivities: new Map(),
    timer: null,
    task: Promise.resolve(true),
    cancelled: false,
    sendFailed: false,
  };
}

export class CompactProgressStreamer {
  private readonly states = new Map<string, CompactProgressState>();
  private readonly heldBySession = new Map<string, HeldStretch>();
  private readonly finalizing = new Set<CompactProgressState>();
  // Cards closed for their stretch that still show a running background operation.
  private readonly parked = new Set<CompactProgressState>();
  private readonly throttleMs: StreamThrottleMs;
  private readonly sendText: CompactProgressStreamerOptions["sendText"];
  private readonly editText: CompactProgressStreamerOptions["editText"];
  private readonly deleteText: CompactProgressStreamerOptions["deleteText"];
  private readonly onPark: CompactProgressStreamerOptions["onPark"];

  constructor({
    throttleMs,
    sendText,
    editText,
    deleteText,
    onPark,
  }: CompactProgressStreamerOptions) {
    this.throttleMs = throttleMs;
    this.sendText = sendText;
    this.editText = editText;
    this.deleteText = deleteText;
    this.onPark = onPark;
  }

  private resolveThrottleMs(sessionId: string): number {
    return resolveStreamThrottleMs(this.throttleMs, sessionId);
  }

  updateActivity(sessionId: string, activity: string): void {
    const normalizedActivity = activity.trim();
    if (!sessionId || !normalizedActivity) {
      return;
    }

    const held = this.heldBySession.get(sessionId);
    if (held) {
      held.activity = normalizedActivity;
      return;
    }

    this.updateActivityState(sessionId, normalizedActivity, true);
  }

  holdForClose(sessionId: string): void {
    if (!sessionId || this.heldBySession.has(sessionId)) {
      return;
    }

    this.heldBySession.set(sessionId, { activity: null, toolCallIds: [] });
  }

  isHolding(sessionId: string): boolean {
    return this.heldBySession.has(sessionId);
  }

  hasPendingSend(sessionId: string): boolean {
    const state = this.states.get(sessionId);
    return Boolean(state && state.messageId === null && !state.cancelled && state.latestText.trim());
  }

  async flushPending(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state || state.messageId !== null || state.cancelled) {
      return;
    }

    if (!state.timer) {
      await state.task;
      return;
    }

    this.clearTimer(state);
    await this.enqueueTask(state, () => this.syncState(state, "flush"));
  }

  releaseHold(sessionId: string): void {
    const held = this.heldBySession.get(sessionId);
    this.heldBySession.delete(sessionId);
    this.replayHeld(sessionId, held);
  }

  updateThinking(sessionId: string): void {
    this.updateActivity(sessionId, t("progress.compact.thinking"));
  }

  updateResponding(sessionId: string): void {
    this.updateActivity(sessionId, t("progress.compact.responding"));
  }

  addToolCall(sessionId: string, callId: string): void {
    if (!sessionId || !callId) {
      return;
    }

    const held = this.heldBySession.get(sessionId);
    if (held) {
      if (!held.toolCallIds.includes(callId)) {
        held.toolCallIds.push(callId);
      }
      return;
    }

    this.states.get(sessionId)?.toolCallIds.add(callId);
  }

  addFileChange(sessionId: string, filePath: string): void {
    const normalizedPath = filePath.trim();
    if (!sessionId || !normalizedPath) {
      return;
    }

    this.states.get(sessionId)?.filePaths.add(normalizedPath);
  }

  /** Registers a background operation on the open card, or updates its text on its own card. */
  addBackgroundOperation(sessionId: string, callId: string, activity: string): void {
    if (!sessionId || !callId || !activity.trim()) {
      return;
    }

    if (this.findBackgroundCard(sessionId, callId)) {
      this.updateBackgroundOperation(sessionId, callId, activity);
      return;
    }

    this.getOrCreateState(sessionId).backgroundActivities.set(callId, activity.trim());
  }

  updateBackgroundOperation(sessionId: string, callId: string, activity: string): void {
    const state = this.findBackgroundCard(sessionId, callId);
    if (!state || !activity.trim()) {
      return;
    }

    state.backgroundActivities.set(callId, activity.trim());
    if (this.parked.has(state)) {
      this.showNewestBackgroundOperation(state);
    }
  }

  /** Counts the ended operation on its own card and closes a parked card left with none. */
  async endBackgroundOperation(
    sessionId: string,
    callId: string,
    deleteOnFinish = false,
  ): Promise<void> {
    const state = this.findBackgroundCard(sessionId, callId);
    if (!state) {
      return;
    }

    state.backgroundActivities.delete(callId);
    state.toolCallIds.add(callId);
    if (!this.parked.has(state)) {
      return;
    }

    if (state.backgroundActivities.size > 0) {
      this.showNewestBackgroundOperation(state);
      return;
    }

    this.parked.delete(state);
    this.clearTimer(state);
    this.finalizing.add(state);
    await this.closeState(state, deleteOnFinish);
  }

  /** Forgets background operations of a session (or all); their cards stay as they are. */
  dropBackgroundOperations(sessionId?: string): void {
    for (const state of this.states.values()) {
      if (sessionId === undefined || state.sessionId === sessionId) {
        state.backgroundActivities.clear();
      }
    }
    this.cancelParked(sessionId);
  }

  async finalize(sessionId: string, deleteOnFinish = false): Promise<void> {
    const state = this.states.get(sessionId);
    if (state) {
      this.clearTimer(state);
      this.states.delete(sessionId);
      if (state.backgroundActivities.size > 0) {
        this.parked.add(state);
      } else {
        this.finalizing.add(state);
      }
    }

    const held = this.heldBySession.get(sessionId);
    this.heldBySession.delete(sessionId);
    const parked = state && this.parked.has(state) ? state : undefined;
    if (parked) {
      this.onPark?.(sessionId, Array.from(parked.backgroundActivities.keys()));
      // A timer tick of a background operation held during the close belongs to the
      // parked card, not to the next stretch.
      if (held?.activity && Array.from(parked.backgroundActivities.values()).includes(held.activity)) {
        held.activity = null;
      }
    }
    this.replayHeld(sessionId, held);

    if (!state) {
      return;
    }

    if (parked) {
      this.showNewestBackgroundOperation(parked);
      return;
    }

    await this.closeState(state, deleteOnFinish);
  }

  private async closeState(state: CompactProgressState, deleteOnFinish: boolean): Promise<void> {
    try {
      await state.task.catch(() => false);

      if (state.cancelled || (state.messageId === null && state.sendFailed)) {
        return;
      }

      if (deleteOnFinish && this.deleteText) {
        await this.deleteProgressMessage(state);
        return;
      }

      state.latestText = t("progress.compact.done", {
        header: t("progress.compact.finished_header"),
        tools: state.toolCallIds.size,
        files: state.filePaths.size,
      });

      await this.syncState(state, "finalize");
    } finally {
      this.finalizing.delete(state);
      this.cancelState(state);
    }
  }

  private async deleteProgressMessage(state: CompactProgressState): Promise<void> {
    if (state.messageId === null) {
      return;
    }

    try {
      await this.deleteText?.(state.sessionId, state.messageId);
    } catch (error) {
      logger.error(
        `[CompactProgress] Failed to delete progress message: session=${state.sessionId}, error=${getErrorMessage(error)}`,
        error,
      );
    }
  }

  clearSession(sessionId: string, reason: string): void {
    const cancelledParked = this.cancelParked(sessionId);
    const cleared = this.clearOpenCard(sessionId);
    if (!cleared && !cancelledParked) {
      return;
    }

    logger.debug(`[CompactProgress] Cleared session: session=${sessionId}, reason=${reason}`);
  }

  /** Drops the open card only; parked cards keep showing their background operations. */
  discardOpenCard(sessionId: string, reason: string): void {
    if (this.clearOpenCard(sessionId)) {
      logger.debug(`[CompactProgress] Discarded open card: session=${sessionId}, reason=${reason}`);
    }
  }

  private clearOpenCard(sessionId: string): boolean {
    this.heldBySession.delete(sessionId);
    const state = this.states.get(sessionId);
    if (state) {
      this.clearTimer(state);
      this.cancelState(state);
      this.states.delete(sessionId);
    }

    const cancelledFinalizing = this.cancelFinalizing(sessionId);
    return Boolean(state) || cancelledFinalizing;
  }

  clearAll(reason: string): void {
    this.heldBySession.clear();
    for (const state of this.states.values()) {
      this.clearTimer(state);
      this.cancelState(state);
    }
    this.states.clear();
    this.cancelFinalizing();
    this.cancelParked();
    logger.debug(`[CompactProgress] Cleared all sessions: reason=${reason}`);
  }

  private findBackgroundCard(sessionId: string, callId: string): CompactProgressState | undefined {
    const open = this.states.get(sessionId);
    if (open?.backgroundActivities.has(callId)) {
      return open;
    }

    for (const state of this.parked) {
      if (state.sessionId === sessionId && state.backgroundActivities.has(callId)) {
        return state;
      }
    }

    return undefined;
  }

  /** A parked card shows the most recently started background operation still running. */
  private showNewestBackgroundOperation(state: CompactProgressState): void {
    const activity = Array.from(state.backgroundActivities.values()).pop();
    if (!activity) {
      return;
    }

    state.latestText = t("progress.compact.activity", {
      header: t("progress.compact.working_header"),
      activity,
    });
    this.ensureTimer(state);
  }

  private cancelParked(sessionId?: string): boolean {
    let cancelled = false;
    for (const state of Array.from(this.parked)) {
      if (sessionId === undefined || state.sessionId === sessionId) {
        this.clearTimer(state);
        this.cancelState(state);
        this.parked.delete(state);
        cancelled = true;
      }
    }
    return cancelled;
  }

  private replayHeld(sessionId: string, held: HeldStretch | undefined): void {
    if (!held) {
      return;
    }

    if (held.activity) {
      this.updateActivity(sessionId, held.activity);
    }

    for (const callId of held.toolCallIds) {
      this.addToolCall(sessionId, callId);
    }
  }

  private getOrCreateState(sessionId: string): CompactProgressState {
    const existing = this.states.get(sessionId);
    if (existing) {
      return existing;
    }

    const state = createInitialState(sessionId);
    this.states.set(sessionId, state);
    return state;
  }

  private updateActivityState(sessionId: string, activity: string, createIfMissing: boolean): void {
    const normalizedActivity = activity.trim();
    if (!sessionId || !normalizedActivity) {
      return;
    }

    const state = createIfMissing ? this.getOrCreateState(sessionId) : this.states.get(sessionId);
    if (!state) {
      return;
    }

    state.latestText = t("progress.compact.activity", {
      header: t("progress.compact.working_header"),
      activity: normalizedActivity,
    });
    this.ensureTimer(state);
  }

  private ensureTimer(state: CompactProgressState): void {
    if (state.cancelled || state.timer) {
      return;
    }

    const throttleMs = this.resolveThrottleMs(state.sessionId);
    if (throttleMs <= 0) {
      state.task = this.enqueueTask(state, () => this.syncState(state, "immediate"));
      return;
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      state.task = this.enqueueTask(state, () => this.syncState(state, "throttle"));
    }, throttleMs);
  }

  private enqueueTask(
    state: CompactProgressState,
    task: () => Promise<boolean>,
  ): Promise<boolean> {
    const nextTask = state.task
      .catch(() => false)
      .then(async () => {
        if (state.cancelled) {
          return false;
        }
        return task();
      });
    state.task = nextTask;
    return nextTask;
  }

  private async syncState(state: CompactProgressState, reason: string): Promise<boolean> {
    const text = state.latestText.trim();
    if (!text || state.cancelled) {
      return false;
    }

    try {
      if (state.messageId === null) {
        state.messageId = await this.sendText(state.sessionId, text);
      } else {
        await this.editText(state.sessionId, state.messageId, text);
      }

      logger.debug(
        `[CompactProgress] Synced progress message: session=${state.sessionId}, reason=${reason}`,
      );
      return true;
    } catch (error) {
      logger.error(
        `[CompactProgress] Failed to sync progress message: session=${state.sessionId}, reason=${reason}, error=${getErrorMessage(error)}`,
        error,
      );
      if (state.messageId === null) {
        state.sendFailed = true;
      }
      return false;
    }
  }

  private clearTimer(state: CompactProgressState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private cancelState(state: CompactProgressState): void {
    state.cancelled = true;
  }

  private cancelFinalizing(sessionId?: string): boolean {
    let cancelled = false;
    for (const state of this.finalizing) {
      if (sessionId === undefined || state.sessionId === sessionId) {
        this.cancelState(state);
        cancelled = true;
      }
    }
    return cancelled;
  }
}

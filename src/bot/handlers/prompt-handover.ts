import type { Context } from "grammy";
import {
  promptHandover,
  type ArrivalTicket,
  type HandedOverPrompt,
  type HandoverSelection,
  type SessionHandover,
} from "../../app/managers/prompt-handover-manager.js";
import { promptQueue, type QueuedPromptInput } from "../../app/managers/prompt-queue-manager.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { cancelInboxPrompt } from "../../app/services/prompt-inbox-service.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { getPromptQueueMode } from "../../app/stores/settings-store.js";
import type { SessionInfo } from "../../app/types/session.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { opencodeClient, opencodeServerVersion } from "../../opencode/client.js";
import { formatErrorDetails } from "../../utils/error-format.js";
import { logger } from "../../utils/logger.js";
import { isOpencodeNotFoundError } from "../../utils/opencode-error.js";
import {
  admitHandedOverPromptToInbox,
  prepareHandedOverPrompt,
  type ProcessPromptDeps,
} from "./prompt.js";

const STATUS_POLL_INTERVAL_MS = 1500;
/** How long a sent prompt may stay unseen as busy before its turn counts as already over. */
const TURN_START_GRACE_MS = 5000;

// Received once at startup, like the queue dispatcher: the delivery loop runs without
// an update context.
let handoverDeps: ProcessPromptDeps | null = null;
// Continues the attached queue, which waits behind prompts handed over to its session.
let onHandoverDrained: (() => Promise<void>) | null = null;

const runningLoops = new Set<string>();
const wakers = new Map<string, () => void>();

export function initializePromptHandover(
  deps: ProcessPromptDeps,
  onDrained: () => Promise<void>,
): void {
  handoverDeps = deps;
  onHandoverDrained = onDrained;
}

async function readSelection(): Promise<HandoverSelection> {
  const agent = await resolveProjectAgent(getStoredAgent());
  const model = getStoredModel();
  return {
    agent,
    providerID: model.providerID,
    modelID: model.modelID,
    variant: model.variant,
  };
}

/**
 * /detach: what waits for the running turn stays with the session instead of being
 * withdrawn. V2 inbox entries are left in OpenCode; V1 prompts are sent by the bot
 * after the turn ends. Must run before the session is cleared.
 */
export async function handOverPromptQueue(session: SessionInfo): Promise<void> {
  const selection = await readSelection();
  promptHandover.recordDetach(session, selection);

  for (const item of promptQueue.handOver(session.id, "detach_command")) {
    if (item.inbox) {
      promptHandover.addInboxEntry(item.inbox);
      continue;
    }
    promptHandover.addPrompt(session.id, {
      text: item.text,
      fileParts: item.fileParts,
      photos: item.photos,
      selection,
    });
  }

  startDeliveryLoop(session.id);
}

/**
 * A message whose preparation outlived /detach goes to the session it was sent to, as one
 * sent right before /detach. Returns false when that session was not detached since.
 */
export async function handOverPreparedPrompt(
  ctx: Context,
  ticket: ArrivalTicket,
  input: QueuedPromptInput,
): Promise<boolean> {
  const record = promptHandover.get(ticket.sessionId);
  if (!record || !promptHandover.wasDetachedSince(ticket) || !handoverDeps) {
    return false;
  }
  logger.info(
    `[PromptHandover] Prepared prompt follows its detached session: session=${record.sessionId}`,
  );

  if (opencodeServerVersion !== "v2") {
    promptHandover.addPrompt(record.sessionId, {
      text: input.text,
      fileParts: [...input.fileParts],
      photos: [...input.photos],
      selection: record.selection,
    });
    startDeliveryLoop(record.sessionId);
    return true;
  }

  const delivery = getPromptQueueMode() === "steer" ? "steer" : "queue";
  const inboxId = await admitHandedOverPromptToInbox(
    ctx.api,
    input,
    { id: record.sessionId, directory: record.directory },
    record.selection,
    delivery,
    handoverDeps,
  );
  if (!inboxId) {
    await notifyDeliveryFailure(record.sessionId);
    return true;
  }

  const inbox = { sessionId: record.sessionId, inboxId, delivery } as const;
  if (!promptHandover.addInboxEntry(inbox)) {
    // Withdrawn by /abort or /opencode_stop while the prompt was on its way.
    await cancelInboxPrompt(inbox, "withdrawn_during_handover");
  }
  return true;
}

/** /abort in the session: what was handed over to it is withdrawn with the rest. */
export async function withdrawHandedOverPrompts(sessionId: string, reason: string): Promise<void> {
  promptQueue.withdrawHandedOverReservations(sessionId);
  const inboxEntries = promptHandover.withdraw(sessionId, reason);
  wakers.get(sessionId)?.();
  await Promise.all(inboxEntries.map((inbox) => cancelInboxPrompt(inbox, reason)));
}

/** /opencode_stop: everything handed over to any session is withdrawn. */
export async function withdrawAllHandedOverPrompts(reason: string): Promise<void> {
  promptQueue.withdrawHandedOverReservations();
  const inboxEntries = promptHandover.withdrawAll(reason);
  for (const wake of wakers.values()) {
    wake();
  }
  await Promise.all(inboxEntries.map((inbox) => cancelInboxPrompt(inbox, reason)));
}

/** A session went idle or failed: its delivery loop checks the status now. */
export function wakePromptHandover(sessionId: string): void {
  wakers.get(sessionId)?.();
}

function startDeliveryLoop(sessionId: string): void {
  if (!promptHandover.hasPendingPrompts(sessionId)) {
    return;
  }
  if (runningLoops.has(sessionId)) {
    wakePromptHandover(sessionId);
    return;
  }

  const record = promptHandover.get(sessionId);
  if (!record) {
    return;
  }

  runningLoops.add(sessionId);
  void runDeliveryLoop(record)
    .catch((err) => {
      logger.error(`[PromptHandover] Delivery loop failed: session=${sessionId}`, err);
    })
    .finally(() => {
      runningLoops.delete(sessionId);
      // Prompts handed over while the loop was finishing - to this record, or to a new one
      // after a withdrawal and another /detach - start it again.
      startDeliveryLoop(sessionId);
    });
}

function isLive(record: SessionHandover): boolean {
  return promptHandover.get(record.sessionId) === record;
}

/** Sends the V1 prompts one by one, each after the session's running turn has ended. */
async function runDeliveryLoop(record: SessionHandover): Promise<void> {
  const { sessionId } = record;

  while (isLive(record) && record.prompts.length > 0) {
    if (!(await waitUntilIdle(record))) {
      return;
    }

    const prompt = promptHandover.takeNextPrompt(sessionId);
    if (!prompt) {
      break;
    }

    promptHandover.setTurnInFlight(sessionId, true);
    try {
      const sent = await sendHandedOverPrompt(record, prompt);
      if (sent) {
        await waitForTurnEnd(record);
      }
    } finally {
      promptHandover.setTurnInFlight(sessionId, false);
    }
  }

  // The attached queue waited behind the handed-over prompts.
  if (isLive(record) && getCurrentSession()?.id === sessionId) {
    void onHandoverDrained?.();
  }
}

type SessionStatus = "busy" | "idle" | "unknown";

async function readSessionStatus(record: SessionHandover): Promise<SessionStatus> {
  try {
    const { data, error } = await opencodeClient.session.status({ directory: record.directory });
    if (error || !data) {
      logger.debug(`[PromptHandover] Failed to read session status: session=${record.sessionId}`);
      return "unknown";
    }
    const status = (data as Record<string, { type?: string }>)[record.sessionId];
    return status?.type === "busy" || status?.type === "retry" ? "busy" : "idle";
  } catch (err) {
    logger.debug(
      `[PromptHandover] Failed to read session status: session=${record.sessionId}`,
      err,
    );
    return "unknown";
  }
}

function waitForWakeOrTimeout(sessionId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      if (wakers.get(sessionId) === done) {
        wakers.delete(sessionId);
      }
      resolve();
    }
    wakers.set(sessionId, done);
  });
}

/** False when the hand-over was withdrawn meanwhile. */
async function waitUntilIdle(record: SessionHandover): Promise<boolean> {
  while (isLive(record)) {
    if ((await readSessionStatus(record)) === "idle") {
      return isLive(record);
    }
    await waitForWakeOrTimeout(record.sessionId, STATUS_POLL_INTERVAL_MS);
  }
  return false;
}

/** Waits for the turn the prompt started; one too quick to be seen busy ends after the grace. */
async function waitForTurnEnd(record: SessionHandover): Promise<void> {
  const sentAt = Date.now();
  let seenBusy = false;

  while (isLive(record)) {
    await waitForWakeOrTimeout(record.sessionId, STATUS_POLL_INTERVAL_MS);
    const status = await readSessionStatus(record);
    if (status === "busy") {
      seenBusy = true;
    } else if (status === "idle" && (seenBusy || Date.now() - sentAt >= TURN_START_GRACE_MS)) {
      return;
    }
  }
}

async function sendHandedOverPrompt(
  record: SessionHandover,
  prompt: HandedOverPrompt,
): Promise<boolean> {
  const deps = handoverDeps;
  if (!deps) {
    return false;
  }

  const session = { id: record.sessionId, directory: record.directory };
  try {
    const promptOptions = await prepareHandedOverPrompt(
      deps.bot.api,
      prompt,
      session,
      prompt.selection,
      deps,
    );
    if (!promptOptions) {
      logger.warn(`[PromptHandover] Handed-over prompt has nothing to send: session=${session.id}`);
      return false;
    }
    if (!isLive(record)) {
      return false;
    }

    logger.info(`[PromptHandover] Sending handed-over prompt: session=${session.id}`);
    const { error } = await opencodeClient.session.promptAsync(promptOptions);
    if (!error) {
      return true;
    }

    logger.error(
      `[PromptHandover] OpenCode refused the handed-over prompt: session=${session.id}`,
      formatErrorDetails(error, 6000),
    );
    if (isOpencodeNotFoundError(error)) {
      promptHandover.withdraw(session.id, "session_not_found");
    }
  } catch (err) {
    logger.error(`[PromptHandover] Failed to send handed-over prompt: session=${session.id}`, err);
  }

  await notifyDeliveryFailure(session.id);
  return false;
}

/** A failed delivery is posted only when the bot has re-attached to that session. */
async function notifyDeliveryFailure(sessionId: string): Promise<void> {
  const deps = handoverDeps;
  if (!deps?.attachManager.isAttachedSession(sessionId)) {
    return;
  }

  await deps.bot.api
    .sendMessage(config.telegram.allowedUserId, t("bot.prompt_send_error"))
    .catch((err) => {
      logger.error("[PromptHandover] Failed to report a handed-over prompt failure:", err);
    });
}

/** Test helper: forgets the dependencies and running loops. */
export function __resetPromptHandoverForTests(): void {
  handoverDeps = null;
  onHandoverDrained = null;
  for (const wake of wakers.values()) {
    wake();
  }
  wakers.clear();
  runningLoops.clear();
}

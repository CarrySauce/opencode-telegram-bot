import {
  isModelCatalogWarmupActive,
  reconcileStoredModelSelection,
  startModelCatalogWarmup,
  type StoredModelReconcileResult,
} from "../app/services/model-selection-service.js";
import { warmupSessionDirectoryCache } from "../app/services/session-cache-service.js";
import { logger } from "../utils/logger.js";
import { safeBackgroundTask } from "../utils/safe-background-task.js";
import type { AppContainer } from "../app/bootstrap/app-container.js";
import { checkOpencodeHealth } from "./server-health.js";

export type ReadyRefreshDeps = Pick<AppContainer, "opencodeReadyLifecycle">;

const MODEL_CATALOG_WAIT_TIMEOUT_MS = 3000;
const MODEL_CATALOG_POLL_INTERVAL_MS = 500;
const MODEL_CATALOG_WARMUP_POLL_INTERVAL_MS = 5000;

let readyRefreshRegistered = false;
let modelCatalogWaitGeneration = 0;
let cancelModelCatalogWaitDelay: (() => void) | null = null;
let lateModelCatalogSettle: Promise<boolean> = Promise.resolve(false);

function isModelCatalogComplete(result: StoredModelReconcileResult): boolean {
  return result.catalogAvailable && result.catalogComplete;
}

// The session restore that runs next reads the selected model's name and context limit.
function isModelCatalogReadyForRestore(result: StoredModelReconcileResult): boolean {
  return result.catalogAvailable && (result.selectedModelListed || result.catalogComplete);
}

/** Resolves after the delay, or at once when the wait is stopped. */
function delayModelCatalogWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cancelModelCatalogWaitDelay = null;
      resolve();
    }, delayMs);

    cancelModelCatalogWaitDelay = () => {
      clearTimeout(timer);
      cancelModelCatalogWaitDelay = null;
      resolve();
    };
  });
}

/**
 * Stop waiting for the model catalog: the pending delay ends at once, and the wait
 * returns without another read and without a late settle.
 */
export function stopModelCatalogWait(): void {
  modelCatalogWaitGeneration++;
  cancelModelCatalogWaitDelay?.();
}

/**
 * Resolves true when, after the ready handler returned, the selected model became listed
 * or fell back to the config model — what the session restore drew is then out of date.
 */
export function waitForLateModelCatalogSettle(): Promise<boolean> {
  return lateModelCatalogSettle;
}

// Plugin providers can be listed seconds after the built-in ones: keep reading until every
// expected provider is listed or the warm-up window closes, then read once more outside it.
async function waitForCompleteModelCatalog(
  reason: string,
  generation: number,
  selectedModelListedOnReturn: boolean,
): Promise<boolean> {
  for (;;) {
    await delayModelCatalogWait(MODEL_CATALOG_WARMUP_POLL_INTERVAL_MS);
    if (generation !== modelCatalogWaitGeneration) {
      return false;
    }

    const warmupEnded = !isModelCatalogWarmupActive();
    const result = await reconcileStoredModelSelection({ forceCatalogRefresh: true });
    if (generation !== modelCatalogWaitGeneration) {
      return false;
    }

    if (!warmupEnded && !isModelCatalogComplete(result)) {
      logger.debug(
        `[OpenCodeReady] Model catalog still lacks expected providers, retrying: reason=${reason}`,
      );
      continue;
    }

    if (warmupEnded) {
      logger.warn(
        `[OpenCodeReady] Model catalog warm-up ended with expected providers missing: reason=${reason}`,
      );
    }

    return (
      !selectedModelListedOnReturn && (result.selectedModelListed || result.storedModelReplaced)
    );
  }
}

// A freshly started server answers health before it lists every model, so wait (bounded)
// for a catalog naming the selected model before the rest of the ready sequence reads it,
// and leave waiting for the remaining expected providers to the background.
async function refreshModelCatalogAfterReady(reason: string): Promise<void> {
  stopModelCatalogWait();
  const generation = modelCatalogWaitGeneration;
  lateModelCatalogSettle = Promise.resolve(false);
  const startedAt = Date.now();

  let result = await reconcileStoredModelSelection({ forceCatalogRefresh: true });
  while (!isModelCatalogReadyForRestore(result)) {
    if (Date.now() - startedAt >= MODEL_CATALOG_WAIT_TIMEOUT_MS) {
      const state = result.catalogAvailable ? "incomplete" : "unavailable";
      logger.warn(
        `[OpenCodeReady] Model catalog still ${state} after ${MODEL_CATALOG_WAIT_TIMEOUT_MS}ms: reason=${reason}`,
      );
      break;
    }

    logger.debug(`[OpenCodeReady] Model catalog not ready yet, retrying: reason=${reason}`);
    await delayModelCatalogWait(MODEL_CATALOG_POLL_INTERVAL_MS);
    if (generation !== modelCatalogWaitGeneration) {
      return;
    }

    result = await reconcileStoredModelSelection({ forceCatalogRefresh: true });
  }

  if (generation !== modelCatalogWaitGeneration || isModelCatalogComplete(result)) {
    return;
  }

  const selectedModelListedOnReturn = result.selectedModelListed;
  logger.debug(
    `[OpenCodeReady] Waiting in background for expected model providers: reason=${reason}`,
  );
  lateModelCatalogSettle = new Promise((resolve) => {
    safeBackgroundTask({
      taskName: "opencode.modelCatalogWarmup",
      task: () => waitForCompleteModelCatalog(reason, generation, selectedModelListedOnReturn),
      onSuccess: resolve,
      onError: () => resolve(false),
    });
  });
}

/**
 * A config reload registers providers again the way a server start does: the same warm-up
 * window and catalog wait, without the session cache warm-up a reload does not affect.
 */
export async function refreshModelCatalogAfterConfigReload(): Promise<void> {
  startModelCatalogWarmup();
  await refreshModelCatalogAfterReady("config_reload");
}

export async function isOpencodeServerHealthy(): Promise<boolean> {
  return (await checkOpencodeHealth()).healthy;
}

export async function refreshSessionCacheAfterOpencodeReady(reason: string): Promise<void> {
  startModelCatalogWarmup();

  try {
    await warmupSessionDirectoryCache();
    logger.debug(`[OpenCodeReady] Session cache refreshed: reason=${reason}`);
  } catch (error) {
    logger.warn(`[OpenCodeReady] Failed to refresh session cache: reason=${reason}`, error);
  }

  try {
    await refreshModelCatalogAfterReady(reason);
    logger.debug(`[OpenCodeReady] Model catalog refreshed: reason=${reason}`);
  } catch (error) {
    logger.warn(`[OpenCodeReady] Failed to refresh model catalog: reason=${reason}`, error);
  }
}

export async function refreshSessionCacheIfOpencodeReady(
  reason: string,
  deps: ReadyRefreshDeps,
): Promise<boolean> {
  if (!(await isOpencodeServerHealthy())) {
    deps.opencodeReadyLifecycle.notifyUnavailable(reason);
    logger.warn(
      `[OpenCodeReady] OpenCode server is not running; skipping session cache refresh: reason=${reason}`,
    );
    return false;
  }

  await refreshSessionCacheAfterOpencodeReady(reason);
  return true;
}

export function registerOpenCodeReadyRefreshHandler(deps: ReadyRefreshDeps): void {
  if (readyRefreshRegistered) {
    return;
  }

  readyRefreshRegistered = true;
  deps.opencodeReadyLifecycle.onReady((reason) => refreshSessionCacheAfterOpencodeReady(reason));
}

export async function notifyOpencodeReadyIfHealthy(
  reason: string,
  deps: ReadyRefreshDeps,
): Promise<boolean> {
  if (!(await isOpencodeServerHealthy())) {
    deps.opencodeReadyLifecycle.notifyUnavailable(reason);
    logger.warn(`[OpenCodeReady] OpenCode server is not running: reason=${reason}`);
    return false;
  }

  return deps.opencodeReadyLifecycle.notifyReady(reason);
}

export function __resetReadyRefreshForTests(): void {
  stopModelCatalogWait();
  lateModelCatalogSettle = Promise.resolve(false);
}

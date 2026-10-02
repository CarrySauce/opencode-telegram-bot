import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  healthMock: vi.fn(),
  warmupSessionDirectoryCacheMock: vi.fn(),
  reconcileStoredModelSelectionMock: vi.fn(),
  startModelCatalogWarmupMock: vi.fn(),
  isModelCatalogWarmupActiveMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: {
    global: {
      health: mocked.healthMock,
    },
  },
}));

vi.mock("../../src/app/services/session-cache-service.js", () => ({
  __resetSessionDirectoryCacheForTests: vi.fn(),
  warmupSessionDirectoryCache: mocked.warmupSessionDirectoryCacheMock,
}));

vi.mock("../../src/app/services/model-selection-service.js", () => ({
  reconcileStoredModelSelection: mocked.reconcileStoredModelSelectionMock,
  startModelCatalogWarmup: mocked.startModelCatalogWarmupMock,
  isModelCatalogWarmupActive: mocked.isModelCatalogWarmupActiveMock,
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    debug: mocked.loggerDebugMock,
    info: vi.fn(),
    warn: mocked.loggerWarnMock,
    error: vi.fn(),
  },
}));

import { OpencodeReadyLifecycle } from "../../src/opencode/ready-lifecycle.js";
import {
  __resetReadyRefreshForTests,
  refreshModelCatalogAfterConfigReload,
  refreshSessionCacheAfterOpencodeReady,
  refreshSessionCacheIfOpencodeReady,
  stopModelCatalogWait,
  watchLateModelCatalogChanges,
  type ReadyRefreshDeps,
} from "../../src/opencode/ready-refresh.js";
import type { StoredModelReconcileResult } from "../../src/app/services/model-selection-service.js";

const UNAVAILABLE: StoredModelReconcileResult = {
  catalogAvailable: false,
  catalogComplete: false,
  selectedModelListed: false,
  storedModelReplaced: false,
};

const COMPLETE: StoredModelReconcileResult = {
  catalogAvailable: true,
  catalogComplete: true,
  selectedModelListed: true,
  storedModelReplaced: false,
};

// Built-in providers listed, the selected model's plugin provider not yet.
const SELECTED_MODEL_MISSING: StoredModelReconcileResult = {
  catalogAvailable: true,
  catalogComplete: false,
  selectedModelListed: false,
  storedModelReplaced: false,
};

// The selected model is listed, a favorite's provider is not yet.
const FAVORITE_PROVIDER_MISSING: StoredModelReconcileResult = {
  catalogAvailable: true,
  catalogComplete: false,
  selectedModelListed: true,
  storedModelReplaced: false,
};

const FELL_BACK: StoredModelReconcileResult = {
  catalogAvailable: true,
  catalogComplete: true,
  selectedModelListed: true,
  storedModelReplaced: true,
};

let deps: ReadyRefreshDeps;
let warmupActive = true;

function watchLateSettle(
  nextChange: () => Promise<boolean> = watchLateModelCatalogChanges(),
): () => boolean | undefined {
  let settled: boolean | undefined;
  void nextChange().then((value) => {
    settled = value;
  });
  return () => settled;
}

describe("opencode/ready-refresh", () => {
  beforeEach(() => {
    deps = { opencodeReadyLifecycle: new OpencodeReadyLifecycle() };
    mocked.healthMock.mockReset();
    mocked.warmupSessionDirectoryCacheMock.mockReset();
    mocked.reconcileStoredModelSelectionMock.mockReset();
    mocked.startModelCatalogWarmupMock.mockReset();
    mocked.isModelCatalogWarmupActiveMock.mockReset();
    mocked.loggerDebugMock.mockReset();
    mocked.loggerWarnMock.mockReset();

    warmupActive = true;
    mocked.isModelCatalogWarmupActiveMock.mockImplementation(() => warmupActive);
    mocked.warmupSessionDirectoryCacheMock.mockResolvedValue(undefined);
    mocked.reconcileStoredModelSelectionMock.mockResolvedValue(COMPLETE);
  });

  afterEach(() => {
    __resetReadyRefreshForTests();
    vi.useRealTimers();
  });

  it("skips refresh with a short warning when OpenCode server is unavailable", async () => {
    mocked.healthMock.mockRejectedValueOnce(new Error("fetch failed"));

    const refreshed = await refreshSessionCacheIfOpencodeReady("startup", deps);

    expect(refreshed).toBe(false);
    expect(mocked.warmupSessionDirectoryCacheMock).not.toHaveBeenCalled();
    expect(mocked.reconcileStoredModelSelectionMock).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] OpenCode server is not running; skipping session cache refresh: reason=startup",
    );
  });

  it("refreshes cache when OpenCode server is healthy", async () => {
    mocked.healthMock.mockResolvedValueOnce({ data: { healthy: true }, error: null });

    const refreshed = await refreshSessionCacheIfOpencodeReady("startup", deps);

    expect(refreshed).toBe(true);
    expect(mocked.warmupSessionDirectoryCacheMock).toHaveBeenCalledTimes(1);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledWith({
      forceCatalogRefresh: true,
    });
  });

  it("opens the model catalog warm-up window on ready", async () => {
    await refreshSessionCacheAfterOpencodeReady("opencode_start_success");

    expect(mocked.startModelCatalogWarmupMock).toHaveBeenCalledTimes(1);
  });

  it("reloads the model catalog through the warm-up window without the session cache", async () => {
    await refreshModelCatalogAfterConfigReload();

    expect(mocked.startModelCatalogWarmupMock).toHaveBeenCalledTimes(1);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledWith({
      forceCatalogRefresh: true,
    });
    expect(mocked.warmupSessionDirectoryCacheMock).not.toHaveBeenCalled();
  });

  it("logs refresh failures without throwing", async () => {
    mocked.warmupSessionDirectoryCacheMock.mockRejectedValueOnce(new Error("refresh failed"));

    await expect(
      refreshSessionCacheAfterOpencodeReady("opencode_start_success"),
    ).resolves.toBeUndefined();

    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] Failed to refresh session cache: reason=opencode_start_success",
      expect.any(Error),
    );
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledWith({
      forceCatalogRefresh: true,
    });
  });

  it("logs model refresh failures without throwing", async () => {
    mocked.reconcileStoredModelSelectionMock.mockRejectedValueOnce(new Error("model failed"));

    await expect(
      refreshSessionCacheAfterOpencodeReady("opencode_start_success"),
    ).resolves.toBeUndefined();

    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] Failed to refresh model catalog: reason=opencode_start_success",
      expect.any(Error),
    );
  });

  it("retries the model catalog refresh until a non-empty catalog is read", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce(COMPLETE);

    const refresh = refreshSessionCacheAfterOpencodeReady("opencode_start_success");
    await vi.advanceTimersByTimeAsync(1000);
    await refresh;

    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(3);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenLastCalledWith({
      forceCatalogRefresh: true,
    });
    expect(mocked.loggerWarnMock).not.toHaveBeenCalled();
  });

  it("stops waiting for the model catalog after the time limit", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock.mockResolvedValue(UNAVAILABLE);

    let finished = false;
    const refresh = refreshSessionCacheAfterOpencodeReady("auto_restart_interval").then(() => {
      finished = true;
    });

    await vi.advanceTimersByTimeAsync(2500);
    expect(finished).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await refresh;

    expect(finished).toBe(true);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(7);
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] Model catalog still unavailable after 3000ms: reason=auto_restart_interval",
    );
  });

  it("runs ready handlers registered later only after the model catalog is available", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValue(COMPLETE);
    const lifecycle = new OpencodeReadyLifecycle();
    const order: string[] = [];
    lifecycle.onReady(async (reason) => {
      await refreshSessionCacheAfterOpencodeReady(reason);
      order.push("refresh");
    });
    lifecycle.onReady(() => {
      order.push("restore");
    });

    const notify = lifecycle.notifyReady("opencode_start_success");
    await vi.advanceTimersByTimeAsync(500);
    await notify;

    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["refresh", "restore"]);
  });

  it("returns at the first read naming the selected model and keeps waiting for favorites in the background", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock
      .mockResolvedValueOnce(FAVORITE_PROVIDER_MISSING)
      .mockResolvedValueOnce(FAVORITE_PROVIDER_MISSING)
      .mockResolvedValue(COMPLETE);

    await refreshSessionCacheAfterOpencodeReady("opencode_start_success");
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10000);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(3);

    warmupActive = false;
    await vi.advanceTimersByTimeAsync(5000);

    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(4);
    await expect(watchLateModelCatalogChanges()()).resolves.toBe(false);
  });

  it("keeps reading through the warm-up window when the first read is complete, then once after it", async () => {
    vi.useFakeTimers();

    await refreshSessionCacheAfterOpencodeReady("opencode_start_success");
    const lateSettle = watchLateSettle();
    await vi.advanceTimersByTimeAsync(55000);

    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(12);
    expect(lateSettle()).toBeUndefined();

    warmupActive = false;
    await vi.advanceTimersByTimeAsync(5000);

    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(13);
    expect(lateSettle()).toBe(false);
    expect(mocked.loggerWarnMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20000);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(13);
  });

  it("signals at once when the stored model falls back mid-window and keeps reading to the final read", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock
      .mockResolvedValueOnce(COMPLETE)
      .mockResolvedValueOnce(FELL_BACK)
      .mockResolvedValue(COMPLETE);

    await refreshSessionCacheAfterOpencodeReady("opencode_start_success");
    const nextChange = watchLateModelCatalogChanges();
    const firstSettle = watchLateSettle(nextChange);
    await vi.advanceTimersByTimeAsync(5000);

    expect(firstSettle()).toBe(true);

    const secondSettle = watchLateSettle(nextChange);
    await vi.advanceTimersByTimeAsync(20000);
    expect(secondSettle()).toBeUndefined();

    // A model adopted inside the window is corrected by the read after it.
    warmupActive = false;
    mocked.reconcileStoredModelSelectionMock.mockResolvedValue(FELL_BACK);
    await vi.advanceTimersByTimeAsync(5000);

    expect(secondSettle()).toBe(true);
    await expect(nextChange()).resolves.toBe(false);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(7);
  });

  it("signals once while the selection stays listed across reads", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValue(COMPLETE);

    const refresh = refreshSessionCacheAfterOpencodeReady("opencode_start_success");
    await vi.advanceTimersByTimeAsync(3000);
    await refresh;
    const nextChange = watchLateModelCatalogChanges();
    const firstSettle = watchLateSettle(nextChange);
    await vi.advanceTimersByTimeAsync(5000);
    expect(firstSettle()).toBe(true);

    const secondSettle = watchLateSettle(nextChange);
    await vi.advanceTimersByTimeAsync(20000);
    warmupActive = false;
    await vi.advanceTimersByTimeAsync(5000);

    expect(secondSettle()).toBe(false);
  });

  it("signals a late settle when the selected model's provider is listed after the handler returned", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(SELECTED_MODEL_MISSING)
      .mockResolvedValueOnce(COMPLETE);

    const refresh = refreshSessionCacheAfterOpencodeReady("auto_restart_interval");
    await vi.advanceTimersByTimeAsync(3000);
    await refresh;

    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] Model catalog still incomplete after 3000ms: reason=auto_restart_interval",
    );
    const lateSettle = watchLateSettle();
    await vi.advanceTimersByTimeAsync(4000);
    expect(lateSettle()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1000);

    expect(lateSettle()).toBe(true);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(8);
  });

  it("signals a late settle when the selected model falls back after the warm-up ends", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock.mockResolvedValue(SELECTED_MODEL_MISSING);

    const refresh = refreshSessionCacheAfterOpencodeReady("auto_restart_interval");
    await vi.advanceTimersByTimeAsync(3000);
    await refresh;
    const lateSettle = watchLateSettle();
    await vi.advanceTimersByTimeAsync(50000);
    expect(lateSettle()).toBeUndefined();

    warmupActive = false;
    mocked.reconcileStoredModelSelectionMock.mockResolvedValue({
      ...FELL_BACK,
      catalogComplete: false,
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(lateSettle()).toBe(true);
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] Model catalog warm-up ended with expected providers missing: reason=auto_restart_interval",
    );
  });

  it("does not signal when the selected model was already listed when the handler returned", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock
      .mockResolvedValueOnce(FAVORITE_PROVIDER_MISSING)
      .mockResolvedValue(FAVORITE_PROVIDER_MISSING);

    await refreshSessionCacheAfterOpencodeReady("opencode_start_success");
    warmupActive = false;
    mocked.reconcileStoredModelSelectionMock.mockResolvedValue(COMPLETE);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(watchLateModelCatalogChanges()()).resolves.toBe(false);
  });

  it("stops the background wait at once without another read or a signal", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock.mockResolvedValue(FAVORITE_PROVIDER_MISSING);

    await refreshSessionCacheAfterOpencodeReady("opencode_start_success");
    expect(vi.getTimerCount()).toBe(1);

    stopModelCatalogWait();

    await expect(watchLateModelCatalogChanges()()).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(1);
  });

  it("hands a watcher attaching late the change made before it attached", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock
      .mockResolvedValueOnce(COMPLETE)
      .mockResolvedValueOnce(FELL_BACK)
      .mockResolvedValue(COMPLETE);

    await refreshSessionCacheAfterOpencodeReady("opencode_start_success");
    await vi.advanceTimersByTimeAsync(5000);

    const nextChange = watchLateModelCatalogChanges();
    await expect(nextChange()).resolves.toBe(true);

    const lateSettle = watchLateSettle(nextChange);
    await vi.advanceTimersByTimeAsync(20000);
    expect(lateSettle()).toBeUndefined();
  });

  it("supersedes the previous background wait on a newer ready", async () => {
    vi.useFakeTimers();
    mocked.reconcileStoredModelSelectionMock.mockResolvedValue(FAVORITE_PROVIDER_MISSING);

    await refreshSessionCacheAfterOpencodeReady("opencode_start_success");
    const firstSettle = watchLateModelCatalogChanges()();

    await refreshSessionCacheAfterOpencodeReady("auto_restart_interval");

    await expect(firstSettle).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledTimes(2);
  });
});

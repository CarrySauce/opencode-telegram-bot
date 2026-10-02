import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  configMock,
  providersMock,
  getCurrentModelMock,
  setCurrentModelMock,
  setCurrentModelState,
  getCurrentModelState,
  resetCurrentModelState,
  loggerInfoMock,
  loggerWarnMock,
  loggerErrorMock,
  loggerDebugMock,
} = vi.hoisted(() => {
  let currentModel: { providerID: string; modelID: string; variant?: string } | undefined;

  const getCurrentModelMock = vi.fn(() => currentModel);
  const setCurrentModelMock = vi.fn(
    (modelInfo: { providerID: string; modelID: string; variant?: string }) => {
      currentModel = modelInfo;
    },
  );

  return {
    configMock: {
      opencode: {
        model: {
          provider: "opencode",
          modelId: "big-pickle",
        },
      },
    },
    providersMock: vi.fn(),
    getCurrentModelMock,
    setCurrentModelMock,
    setCurrentModelState: (modelInfo?: {
      providerID: string;
      modelID: string;
      variant?: string;
    }) => {
      currentModel = modelInfo;
    },
    getCurrentModelState: () => currentModel,
    resetCurrentModelState: () => {
      currentModel = undefined;
      getCurrentModelMock.mockClear();
      setCurrentModelMock.mockClear();
    },
    loggerInfoMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    loggerDebugMock: vi.fn(),
  };
});

vi.mock("../../../src/config.js", () => ({
  config: configMock,
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    config: {
      providers: providersMock,
    },
  },
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentModel: getCurrentModelMock,
  setCurrentModel: setCurrentModelMock,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    debug: loggerDebugMock,
  },
}));

import {
  __resetModelCatalogCacheForTests,
  getFavoriteModels,
  getModelAvailability,
  getModelSelectionLists,
  getMissingExpectedProviders,
  getProviderModels,
  getProviders,
  readProvidersWhenListed,
  reconcileStoredModelSelection,
  resolveModelToAdopt,
  searchModels,
  startModelCatalogWarmup,
} from "../../../src/app/services/model-selection-service.js";

function createProvidersResponse(modelsByProvider: Record<string, string[]>) {
  return {
    data: {
      providers: Object.entries(modelsByProvider).map(([providerID, modelIDs]) => ({
        id: providerID,
        models: Object.fromEntries(modelIDs.map((modelID) => [modelID, { id: modelID }])),
      })),
    },
    error: null,
  };
}

describe("app/services/model-selection-service", () => {
  let tempDir = "";
  let originalXdgStateHome: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalXdgStateHome = process.env.XDG_STATE_HOME;
    originalHome = process.env.HOME;

    vi.useRealTimers();
    resetCurrentModelState();
    __resetModelCatalogCacheForTests();
    // Menu reads wait for the providers named in model.json; never read the real one.
    process.env.XDG_STATE_HOME = path.join(os.tmpdir(), "opencode-model-test-no-state");

    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
    loggerDebugMock.mockReset();

    providersMock.mockReset();
    providersMock.mockResolvedValue(
      createProvidersResponse({
        opencode: ["big-pickle"],
        openai: ["gpt-4o", "gpt-3.5"],
        anthropic: ["claude-sonnet"],
        google: ["gemini-pro"],
      }),
    );
  });

  afterEach(async () => {
    process.env.XDG_STATE_HOME = originalXdgStateHome;
    process.env.HOME = originalHome;
    vi.useRealTimers();

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  async function setupMockModelFile(content: object): Promise<string> {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-model-test-"));
    const opencodeDir = path.join(tempDir, "opencode");
    await mkdir(opencodeDir, { recursive: true });
    const modelFilePath = path.join(opencodeDir, "model.json");
    await writeFile(modelFilePath, JSON.stringify(content), "utf-8");
    process.env.XDG_STATE_HOME = tempDir;
    return modelFilePath;
  }

  describe("getModelSelectionLists", () => {
    it("returns favorites and recent from model.json", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "anthropic", modelID: "claude-sonnet" },
        ],
        recent: [
          { providerID: "google", modelID: "gemini-pro" },
          { providerID: "openai", modelID: "gpt-3.5" },
        ],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(3); // 2 from file + 1 default
      expect(result.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(result.favorites).toContainEqual({
        providerID: "anthropic",
        modelID: "claude-sonnet",
      });
      expect(result.favorites).toContainEqual({ providerID: "opencode", modelID: "big-pickle" });

      expect(result.recent).toHaveLength(2);
      expect(result.recent).toContainEqual({ providerID: "google", modelID: "gemini-pro" });
      expect(result.recent).toContainEqual({ providerID: "openai", modelID: "gpt-3.5" });
    });

    it("deduplicates models with same provider/model combination", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "openai", modelID: "gpt-4o" }, // duplicate
          { providerID: "anthropic", modelID: "claude-sonnet" },
        ],
        recent: [],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(3); // 2 unique from file + 1 default
      const openaiGpt4oCount = result.favorites.filter(
        (m) => m.providerID === "openai" && m.modelID === "gpt-4o",
      ).length;
      expect(openaiGpt4oCount).toBe(1);
    });

    it("does not include recent models that are already in favorites", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "anthropic", modelID: "claude-sonnet" },
        ],
        recent: [
          { providerID: "openai", modelID: "gpt-4o" }, // duplicate of favorite
          { providerID: "google", modelID: "gemini-pro" }, // unique
        ],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(result.recent).not.toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(result.recent).toContainEqual({ providerID: "google", modelID: "gemini-pro" });
    });

    it("falls back to config model when model.json does not exist", async () => {
      // Set XDG_STATE_HOME to a non-existent directory
      tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-model-test-"));
      process.env.XDG_STATE_HOME = path.join(tempDir, "nonexistent");

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(1);
      expect(result.favorites[0]).toEqual({ providerID: "opencode", modelID: "big-pickle" });
      expect(result.recent).toHaveLength(0);
    });

    it("returns empty lists when file does not exist and no config model", async () => {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-model-test-"));
      process.env.XDG_STATE_HOME = path.join(tempDir, "nonexistent");
      configMock.opencode.model.provider = "";
      configMock.opencode.model.modelId = "";

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(0);
      expect(result.recent).toHaveLength(0);

      // Restore config
      configMock.opencode.model.provider = "opencode";
      configMock.opencode.model.modelId = "big-pickle";
    });

    it("handles missing recent array gracefully", async () => {
      await setupMockModelFile({
        favorite: [{ providerID: "openai", modelID: "gpt-4o" }],
        // no recent field
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(2); // 1 from file + 1 default
      expect(result.recent).toHaveLength(0);
    });

    it("handles missing favorite array gracefully", async () => {
      await setupMockModelFile({
        // no favorite field
        recent: [{ providerID: "openai", modelID: "gpt-4o" }],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(1); // just default
      expect(result.recent).toHaveLength(1);
      expect(result.recent[0]).toEqual({ providerID: "openai", modelID: "gpt-4o" });
    });

    it("filters out invalid model entries with missing providerID", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "", modelID: "invalid-model" },
          { modelID: "no-provider" }, // missing providerID
        ],
        recent: [],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(2); // 1 valid from file + 1 default
      expect(result.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(result.favorites).toContainEqual({ providerID: "opencode", modelID: "big-pickle" });
    });

    it("filters out invalid model entries with missing modelID", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "anthropic", modelID: "" },
          { providerID: "no-model" }, // missing modelID
        ],
        recent: [],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(2); // 1 valid from file + 1 default
      expect(result.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
    });

    it("deduplicates default config model when already in favorites", async () => {
      // configMock has opencode/big-pickle as default
      await setupMockModelFile({
        favorite: [
          { providerID: "opencode", modelID: "big-pickle" }, // same as default
          { providerID: "openai", modelID: "gpt-4o" },
        ],
        recent: [],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(2); // should not duplicate the default
      const opencodeBigPickleCount = result.favorites.filter(
        (m) => m.providerID === "opencode" && m.modelID === "big-pickle",
      ).length;
      expect(opencodeBigPickleCount).toBe(1);
    });

    it("deduplicates recent models", async () => {
      await setupMockModelFile({
        favorite: [],
        recent: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "openai", modelID: "gpt-4o" }, // duplicate
          { providerID: "google", modelID: "gemini-pro" },
        ],
      });

      const result = await getModelSelectionLists();

      expect(result.recent).toHaveLength(2);
      expect(result.recent).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(result.recent).toContainEqual({ providerID: "google", modelID: "gemini-pro" });
    });

    it("filters out models that are not present in provider catalog", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "openai", modelID: "missing-favorite" },
        ],
        recent: [
          { providerID: "google", modelID: "gemini-pro" },
          { providerID: "google", modelID: "missing-recent" },
        ],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(result.favorites).toContainEqual({ providerID: "opencode", modelID: "big-pickle" });
      expect(result.favorites).not.toContainEqual({
        providerID: "openai",
        modelID: "missing-favorite",
      });

      expect(result.recent).toContainEqual({ providerID: "google", modelID: "gemini-pro" });
      expect(result.recent).not.toContainEqual({
        providerID: "google",
        modelID: "missing-recent",
      });
    });

    it("uses model catalog cache between repeated calls", async () => {
      await setupMockModelFile({
        favorite: [{ providerID: "openai", modelID: "gpt-4o" }],
        recent: [{ providerID: "google", modelID: "gemini-pro" }],
      });

      await getModelSelectionLists();
      await getModelSelectionLists();

      expect(providersMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to stale model catalog cache when refresh fails", async () => {
      const startTime = new Date("2026-01-01T00:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(startTime);

      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "openai", modelID: "retired" },
        ],
        recent: [{ providerID: "google", modelID: "gemini-pro" }],
      });

      const first = await getModelSelectionLists();
      expect(first.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(first.favorites).not.toContainEqual({ providerID: "openai", modelID: "retired" });

      providersMock.mockResolvedValueOnce({ data: null, error: new Error("upstream unavailable") });
      vi.setSystemTime(new Date(startTime.getTime() + 11 * 60 * 1000));

      const second = await getModelSelectionLists();

      expect(providersMock).toHaveBeenCalledTimes(2);
      expect(second.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(second.favorites).not.toContainEqual({ providerID: "openai", modelID: "retired" });
    });
  });

  describe("getFavoriteModels", () => {
    it("returns only favorites from getModelSelectionLists", async () => {
      await setupMockModelFile({
        favorite: [{ providerID: "openai", modelID: "gpt-4o" }],
        recent: [{ providerID: "google", modelID: "gemini-pro" }],
      });

      const favorites = await getFavoriteModels();

      expect(favorites).toHaveLength(2); // 1 from file + 1 default
      expect(favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(favorites).toContainEqual({ providerID: "opencode", modelID: "big-pickle" });
      // recent models should not be in favorites
      expect(favorites).not.toContainEqual({ providerID: "google", modelID: "gemini-pro" });
    });
  });

  describe("reconcileStoredModelSelection", () => {
    it("logs a short warning without stack when OpenCode server is unavailable", async () => {
      setCurrentModelState({ providerID: "openai", modelID: "gpt-4o", variant: "high" });
      providersMock.mockResolvedValueOnce({ data: null, error: new TypeError("fetch failed") });

      await reconcileStoredModelSelection();

      expect(loggerWarnMock).toHaveBeenCalledWith(
        "[ModelManager] OpenCode server is not running; skipping model catalog refresh",
      );
      expect(loggerWarnMock).not.toHaveBeenCalledWith(
        "[ModelManager] Failed to refresh model catalog:",
        expect.any(Error),
      );
      expect(loggerWarnMock).toHaveBeenCalledWith(
        "[ModelManager] Skipping stored model validation: model catalog unavailable",
      );
      expect(setCurrentModelMock).not.toHaveBeenCalled();
    });

    it("forces model catalog refresh when requested", async () => {
      setCurrentModelState({ providerID: "openai", modelID: "gpt-4o", variant: "high" });

      await reconcileStoredModelSelection();
      await reconcileStoredModelSelection({ forceCatalogRefresh: true });

      expect(providersMock).toHaveBeenCalledTimes(2);
    });

    it("falls back to env default when stored model is unavailable", async () => {
      setCurrentModelState({ providerID: "openai", modelID: "retired", variant: "high" });

      await reconcileStoredModelSelection();

      expect(getCurrentModelState()).toEqual({
        providerID: "opencode",
        modelID: "big-pickle",
        variant: "default",
      });
      expect(setCurrentModelMock).toHaveBeenCalledTimes(1);
    });

    it("keeps stored model when it is available", async () => {
      setCurrentModelState({ providerID: "openai", modelID: "gpt-4o", variant: "high" });

      await reconcileStoredModelSelection();

      expect(getCurrentModelState()).toEqual({
        providerID: "openai",
        modelID: "gpt-4o",
        variant: "high",
      });
      expect(setCurrentModelMock).not.toHaveBeenCalled();
    });

    it("reports a non-empty catalog as available", async () => {
      setCurrentModelState({ providerID: "openai", modelID: "gpt-4o", variant: "high" });

      await expect(reconcileStoredModelSelection({ forceCatalogRefresh: true })).resolves.toEqual({
        catalogAvailable: true,
        catalogComplete: true,
        selectedModelListed: true,
        storedModelReplaced: false,
      });
    });

    it("reports the catalog even when no model is stored", async () => {
      await expect(
        reconcileStoredModelSelection({ forceCatalogRefresh: true }),
      ).resolves.toMatchObject({ catalogAvailable: true, selectedModelListed: true });
      expect(providersMock).toHaveBeenCalledTimes(1);
    });

    it("reports a replaced stored model", async () => {
      setCurrentModelState({ providerID: "openai", modelID: "retired", variant: "high" });

      await expect(reconcileStoredModelSelection()).resolves.toEqual({
        catalogAvailable: true,
        catalogComplete: true,
        selectedModelListed: true,
        storedModelReplaced: true,
      });
    });

    it("keeps the stored model and reports unavailable when the catalog is empty", async () => {
      setCurrentModelState({ providerID: "openai", modelID: "gpt-4o", variant: "high" });
      providersMock.mockResolvedValueOnce(createProvidersResponse({}));

      const { catalogAvailable } = await reconcileStoredModelSelection({
        forceCatalogRefresh: true,
      });

      expect(catalogAvailable).toBe(false);
      expect(setCurrentModelMock).not.toHaveBeenCalled();
      expect(getCurrentModelState()).toEqual({
        providerID: "openai",
        modelID: "gpt-4o",
        variant: "high",
      });
      expect(loggerWarnMock).toHaveBeenCalledWith(
        "[ModelManager] Skipping stored model validation: model catalog unavailable",
      );
    });

    it("reports unavailable when a failed refresh falls back to the stale catalog", async () => {
      setCurrentModelState({ providerID: "openai", modelID: "gpt-4o", variant: "high" });
      await reconcileStoredModelSelection();
      providersMock.mockResolvedValueOnce({ data: null, error: new Error("upstream unavailable") });

      const { catalogAvailable } = await reconcileStoredModelSelection({
        forceCatalogRefresh: true,
      });

      expect(catalogAvailable).toBe(false);
      expect(setCurrentModelMock).not.toHaveBeenCalled();
    });
  });

  describe("warm-up after a server start", () => {
    const BUILT_IN_ONLY = {
      opencode: ["big-pickle"],
      openai: ["gpt-4o"],
    };
    const WITH_PLUGIN_PROVIDER = {
      ...BUILT_IN_ONLY,
      commandcode: ["deepseek-v4"],
    };

    it("lists nothing as missing outside the warm-up window", async () => {
      setCurrentModelState({ providerID: "commandcode", modelID: "deepseek-v4" });

      await expect(getMissingExpectedProviders(["openai"])).resolves.toEqual([]);
    });

    it("expects the providers of the stored, favorite and recent models", async () => {
      setCurrentModelState({ providerID: "commandcode", modelID: "deepseek-v4" });
      await setupMockModelFile({
        favorite: [{ providerID: "anthropic", modelID: "claude-sonnet" }],
        recent: [{ providerID: "google", modelID: "gemini-pro" }],
      });
      startModelCatalogWarmup();

      const missing = await getMissingExpectedProviders(["openai", "google"]);

      expect(missing.sort()).toEqual(["anthropic", "commandcode"]);
    });

    it("expects the config model's provider when no model is stored", async () => {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-model-test-"));
      process.env.XDG_STATE_HOME = path.join(tempDir, "nonexistent");
      startModelCatalogWarmup();

      await expect(getMissingExpectedProviders(["openai"])).resolves.toEqual(["opencode"]);
    });

    it("keeps a stored model whose provider is not listed yet and reads the catalog again", async () => {
      setCurrentModelState({ providerID: "commandcode", modelID: "deepseek-v4", variant: "high" });
      await setupMockModelFile({ favorite: [], recent: [] });
      startModelCatalogWarmup();
      providersMock.mockResolvedValue(createProvidersResponse(BUILT_IN_ONLY));

      const result = await reconcileStoredModelSelection({ forceCatalogRefresh: true });

      expect(result).toEqual({
        catalogAvailable: true,
        catalogComplete: false,
        selectedModelListed: false,
        storedModelReplaced: false,
      });
      expect(setCurrentModelMock).not.toHaveBeenCalled();

      providersMock.mockResolvedValue(createProvidersResponse(WITH_PLUGIN_PROVIDER));
      const providers = await getProviders();

      expect(providersMock).toHaveBeenCalledTimes(2);
      expect(providers.map((provider) => provider.id)).toContain("commandcode");
      await expect(reconcileStoredModelSelection()).resolves.toMatchObject({
        catalogComplete: true,
        selectedModelListed: true,
      });
      // Inside the warm-up window even a complete list is read again.
      expect(providersMock).toHaveBeenCalledTimes(3);
    });

    it("does not cache a list lacking a favorite's provider, and the menu shows it once listed", async () => {
      await setupMockModelFile({
        favorite: [{ providerID: "commandcode", modelID: "deepseek-v4" }],
        recent: [],
      });
      startModelCatalogWarmup();
      providersMock.mockResolvedValueOnce(createProvidersResponse(BUILT_IN_ONLY));
      await reconcileStoredModelSelection({ forceCatalogRefresh: true });
      providersMock.mockResolvedValue(createProvidersResponse(WITH_PLUGIN_PROVIDER));

      const lists = await getModelSelectionLists();

      expect(lists.favorites).toContainEqual({
        providerID: "commandcode",
        modelID: "deepseek-v4",
      });
      expect(providersMock).toHaveBeenCalledTimes(2);
    });

    it("replaces a stored model that is still not listed once the window has closed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      setCurrentModelState({ providerID: "commandcode", modelID: "deepseek-v4", variant: "high" });
      await setupMockModelFile({ favorite: [], recent: [] });
      startModelCatalogWarmup();
      providersMock.mockResolvedValue(createProvidersResponse(BUILT_IN_ONLY));

      await reconcileStoredModelSelection({ forceCatalogRefresh: true });
      expect(setCurrentModelMock).not.toHaveBeenCalled();

      vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));
      const result = await reconcileStoredModelSelection({ forceCatalogRefresh: true });

      expect(result.storedModelReplaced).toBe(true);
      expect(getCurrentModelState()).toEqual({
        providerID: "opencode",
        modelID: "big-pickle",
        variant: "default",
      });
    });
  });

  describe("waiting for providers after a location wakes", () => {
    const BUILT_IN_ONLY = {
      opencode: ["big-pickle"],
      openai: ["gpt-4o"],
    };
    const WITH_PLUGIN_PROVIDER = {
      ...BUILT_IN_ONLY,
      commandcode: ["deepseek-v4"],
    };

    function listedProviderIds(response: Awaited<ReturnType<typeof readProvidersWhenListed>>) {
      return (response.data?.providers ?? []).map((provider) => provider.id);
    }

    // Waiting for the expected providers first reads model.json, which is real file IO.
    async function untilProviderReads(count: number): Promise<void> {
      await vi.waitFor(() => expect(providersMock.mock.calls.length).toBeGreaterThanOrEqual(count));
    }

    beforeEach(() => {
      vi.useFakeTimers();
      setCurrentModelState({ providerID: "commandcode", modelID: "deepseek-v4" });
    });

    it("returns at once when every awaited provider is listed", async () => {
      providersMock.mockResolvedValue(createProvidersResponse(WITH_PLUGIN_PROVIDER));

      await readProvidersWhenListed();

      expect(providersMock).toHaveBeenCalledTimes(1);
    });

    it("reads again until the missing provider is listed", async () => {
      providersMock.mockResolvedValueOnce(createProvidersResponse(BUILT_IN_ONLY));
      providersMock.mockResolvedValue(createProvidersResponse(WITH_PLUGIN_PROVIDER));

      const read = readProvidersWhenListed("commandcode");
      await vi.advanceTimersByTimeAsync(500);

      expect(listedProviderIds(await read)).toContain("commandcode");
      expect(providersMock).toHaveBeenCalledTimes(2);
    });

    it("waits past a list with no models", async () => {
      providersMock.mockResolvedValueOnce(createProvidersResponse({}));
      providersMock.mockResolvedValueOnce(createProvidersResponse({ commandcode: [] }));
      providersMock.mockResolvedValue(createProvidersResponse(WITH_PLUGIN_PROVIDER));

      const read = readProvidersWhenListed("commandcode");
      await vi.advanceTimersByTimeAsync(1000);

      expect(listedProviderIds(await read)).toContain("commandcode");
      expect(providersMock).toHaveBeenCalledTimes(3);
    });

    it("waits for one provider without waiting for the favorites' providers", async () => {
      setCurrentModelState({ providerID: "openai", modelID: "gpt-4o" });
      await setupMockModelFile({
        favorite: [{ providerID: "commandcode", modelID: "deepseek-v4" }],
        recent: [],
      });
      providersMock.mockResolvedValue(createProvidersResponse(BUILT_IN_ONLY));

      await readProvidersWhenListed("openai");
      expect(providersMock).toHaveBeenCalledTimes(1);

      const fullRead = readProvidersWhenListed();
      await untilProviderReads(2);
      await vi.advanceTimersByTimeAsync(500);
      expect(providersMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(10_000);
      await fullRead;
    });

    it("gives up after 10 s and does not wait for that provider again until it is listed", async () => {
      providersMock.mockResolvedValue(createProvidersResponse(BUILT_IN_ONLY));

      const read = readProvidersWhenListed();
      await untilProviderReads(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(listedProviderIds(await read)).not.toContain("commandcode");
      const callsAfterWait = providersMock.mock.calls.length;

      await readProvidersWhenListed();
      expect(providersMock).toHaveBeenCalledTimes(callsAfterWait + 1);

      providersMock.mockResolvedValueOnce(createProvidersResponse(WITH_PLUGIN_PROVIDER));
      await readProvidersWhenListed();
      const waitingAgain = readProvidersWhenListed();
      await untilProviderReads(callsAfterWait + 3);
      await vi.advanceTimersByTimeAsync(500);
      expect(providersMock).toHaveBeenCalledTimes(callsAfterWait + 4);
      await vi.advanceTimersByTimeAsync(10_000);
      await waitingAgain;
    });

    it("keeps a provider given up on while lists name it without models", async () => {
      setCurrentModelState({ providerID: "openai", modelID: "gpt-4o" });
      await setupMockModelFile({
        favorite: [{ providerID: "commandcode", modelID: "deepseek-v4" }],
        recent: [],
      });
      providersMock.mockResolvedValue(createProvidersResponse(BUILT_IN_ONLY));
      const read = readProvidersWhenListed();
      await untilProviderReads(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await read;

      providersMock.mockResolvedValue(
        createProvidersResponse({ ...BUILT_IN_ONLY, commandcode: [] }),
      );
      await reconcileStoredModelSelection({ forceCatalogRefresh: true });
      const callsBefore = providersMock.mock.calls.length;
      await readProvidersWhenListed();

      expect(providersMock).toHaveBeenCalledTimes(callsBefore + 1);
    });

    it("waits again for a provider given up on once the server starts again", async () => {
      providersMock.mockResolvedValue(createProvidersResponse(BUILT_IN_ONLY));
      const read = readProvidersWhenListed();
      await untilProviderReads(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await read;
      const callsAfterWait = providersMock.mock.calls.length;

      startModelCatalogWarmup();
      const waitingAgain = readProvidersWhenListed();
      await untilProviderReads(callsAfterWait + 1);
      await vi.advanceTimersByTimeAsync(500);

      expect(providersMock).toHaveBeenCalledTimes(callsAfterWait + 2);
      await vi.advanceTimersByTimeAsync(10_000);
      await waitingAgain;
    });

    it("returns a failed read at once", async () => {
      providersMock.mockResolvedValue({ data: null, error: new TypeError("fetch failed") });

      const response = await readProvidersWhenListed();

      expect(response.error).toBeInstanceOf(TypeError);
      expect(providersMock).toHaveBeenCalledTimes(1);
    });

    it("shares one wait between concurrent callers", async () => {
      providersMock.mockResolvedValueOnce(createProvidersResponse(BUILT_IN_ONLY));
      providersMock.mockResolvedValue(createProvidersResponse(WITH_PLUGIN_PROVIDER));

      const first = readProvidersWhenListed();
      const second = readProvidersWhenListed();
      await untilProviderReads(1);
      await vi.advanceTimersByTimeAsync(500);

      expect(await second).toBe(await first);
      expect(providersMock).toHaveBeenCalledTimes(2);
    });

    it("makes the model menu wait, but not the stored-model check", async () => {
      providersMock.mockResolvedValue(createProvidersResponse(BUILT_IN_ONLY));
      startModelCatalogWarmup();

      await reconcileStoredModelSelection({ forceCatalogRefresh: true });
      expect(providersMock).toHaveBeenCalledTimes(1);

      providersMock.mockResolvedValue(createProvidersResponse(WITH_PLUGIN_PROVIDER));
      providersMock.mockResolvedValueOnce(createProvidersResponse(BUILT_IN_ONLY));
      const providers = getProviders();
      await untilProviderReads(2);
      await vi.advanceTimersByTimeAsync(500);

      expect((await providers).map((provider) => provider.id)).toContain("commandcode");
      expect(providersMock).toHaveBeenCalledTimes(3);
    });

    it("does not hand a menu read the stored-model check's in-flight list", async () => {
      let resolveCheckRead: (value: unknown) => void = () => {};
      providersMock.mockImplementationOnce(
        () => new Promise((resolve) => (resolveCheckRead = resolve)),
      );
      providersMock.mockResolvedValue(createProvidersResponse(WITH_PLUGIN_PROVIDER));
      startModelCatalogWarmup();

      const check = reconcileStoredModelSelection({ forceCatalogRefresh: true });
      const menu = getProviders();
      resolveCheckRead(createProvidersResponse(BUILT_IN_ONLY));
      await check;

      expect((await menu).map((provider) => provider.id)).toContain("commandcode");
      expect(providersMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("empty model catalog", () => {
    it("is not cached: the next read asks the server again", async () => {
      providersMock.mockResolvedValueOnce(createProvidersResponse({}));

      await expect(reconcileStoredModelSelection()).resolves.toMatchObject({
        catalogAvailable: false,
      });
      const providers = await getProviders();

      expect(providersMock).toHaveBeenCalledTimes(2);
      expect(providers.map((provider) => provider.id)).toEqual([
        "anthropic",
        "google",
        "openai",
        "opencode",
      ]);
    });

    it("treats providers without models as an empty catalog", async () => {
      providersMock.mockResolvedValueOnce(createProvidersResponse({ openai: [] }));

      await expect(reconcileStoredModelSelection()).resolves.toMatchObject({
        catalogAvailable: false,
      });
      await expect(searchModels("gpt")).resolves.not.toHaveLength(0);
      expect(providersMock).toHaveBeenCalledTimes(2);
    });

    it("drops a previously cached catalog", async () => {
      await getProviders();
      providersMock.mockResolvedValueOnce(createProvidersResponse({}));

      await reconcileStoredModelSelection({ forceCatalogRefresh: true });

      providersMock.mockResolvedValueOnce(createProvidersResponse({}));
      await expect(reconcileStoredModelSelection()).resolves.toMatchObject({
        catalogAvailable: false,
      });
      expect(providersMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("searchModels", () => {
    it("returns matching models by case-insensitive substring", async () => {
      const results = await searchModels("gpt");

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(results).toContainEqual({ providerID: "openai", modelID: "gpt-3.5" });
    });

    it("matches across providerID and modelID", async () => {
      const results = await searchModels("openai");

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results).toContainEqual({ providerID: "openai", modelID: "gpt-3.5" });
      expect(results).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
    });

    it("matches by providerID substring", async () => {
      const results = await searchModels("anthrop");

      expect(results).toContainEqual({ providerID: "anthropic", modelID: "claude-sonnet" });
    });

    it("is case-insensitive", async () => {
      const results = await searchModels("GPT-4O");

      expect(results).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
    });

    it("returns empty array when no models match", async () => {
      const results = await searchModels("nonexistent-model-xyz");

      expect(results).toHaveLength(0);
    });

    it("returns empty array for empty query", async () => {
      const results = await searchModels("   ");

      expect(results).toHaveLength(0);
    });

    it("sorts results alphabetically", async () => {
      const results = await searchModels("gpt");

      const keys = results.map((m) => `${m.providerID}/${m.modelID}`);
      expect(keys).toEqual([...keys].sort());
    });

    it("returns empty array when catalog fetch fails", async () => {
      __resetModelCatalogCacheForTests();
      providersMock.mockResolvedValueOnce({ data: null, error: new Error("fetch failed") });

      const results = await searchModels("gpt");

      expect(results).toHaveLength(0);
    });

    it("uses model catalog cache between repeated calls", async () => {
      __resetModelCatalogCacheForTests();
      providersMock.mockClear();

      await searchModels("gpt");
      await searchModels("claude");

      expect(providersMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("getProviders", () => {
    it("returns providers with model counts sorted by name", async () => {
      const providers = await getProviders();

      expect(providers).toEqual([
        { id: "anthropic", name: "anthropic", modelCount: 1 },
        { id: "google", name: "google", modelCount: 1 },
        { id: "openai", name: "openai", modelCount: 2 },
        { id: "opencode", name: "opencode", modelCount: 1 },
      ]);
    });

    it("uses the provider display name when available", async () => {
      __resetModelCatalogCacheForTests();
      setCurrentModelState({ providerID: "openai", modelID: "gpt-4o" });
      providersMock.mockResolvedValueOnce({
        data: {
          providers: [
            { id: "openai", name: "OpenAI", models: { "gpt-4o": { id: "gpt-4o" } } },
            { id: "zai", models: { "glm-5": { id: "glm-5" } } },
          ],
        },
        error: null,
      });

      const providers = await getProviders();

      expect(providers).toEqual([
        { id: "openai", name: "OpenAI", modelCount: 1 },
        { id: "zai", name: "zai", modelCount: 1 },
      ]);
    });

    it("leaves out a provider with no models left", async () => {
      __resetModelCatalogCacheForTests();
      setCurrentModelState({ providerID: "openai", modelID: "gpt-4o" });
      providersMock.mockResolvedValueOnce({
        data: {
          providers: [
            { id: "openai", name: "OpenAI", models: { "gpt-4o": { id: "gpt-4o" } } },
            { id: "anthropic", name: "Anthropic", models: {} },
          ],
        },
        error: null,
      });

      const providers = await getProviders();

      expect(providers.map((provider) => provider.id)).toEqual(["openai"]);
    });

    it("returns empty array when catalog fetch fails", async () => {
      __resetModelCatalogCacheForTests();
      providersMock.mockResolvedValueOnce({ data: null, error: new Error("fetch failed") });

      await expect(getProviders()).resolves.toEqual([]);
    });

    it("uses model catalog cache between repeated calls", async () => {
      __resetModelCatalogCacheForTests();
      providersMock.mockClear();

      await getProviders();
      await getProviders();

      expect(providersMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("getProviderModels", () => {
    it("returns provider models sorted by model ID", async () => {
      const models = await getProviderModels("openai");

      expect(models).toEqual([
        { providerID: "openai", modelID: "gpt-3.5" },
        { providerID: "openai", modelID: "gpt-4o" },
      ]);
    });

    it("returns empty array for an unknown provider", async () => {
      await expect(getProviderModels("unknown")).resolves.toEqual([]);
    });

    it("returns empty array when catalog fetch fails", async () => {
      __resetModelCatalogCacheForTests();
      providersMock.mockResolvedValueOnce({ data: null, error: new Error("fetch failed") });

      await expect(getProviderModels("openai")).resolves.toEqual([]);
    });
  });

  describe("models OpenCode no longer offers", () => {
    const WITHOUT_OPENAI = {
      opencode: ["big-pickle"],
      google: ["gemini-pro"],
    };

    // A read lacking an awaited provider waits 10 s for it; model.json is real file IO.
    async function afterProviderWait<T>(promise: Promise<T>, readsBefore: number): Promise<T> {
      await vi.waitFor(() => expect(providersMock.mock.calls.length).toBeGreaterThan(readsBefore));
      await vi.advanceTimersByTimeAsync(10_000);
      return promise;
    }

    it("does not serve a catalog cached before the warm-up window opened", async () => {
      await setupMockModelFile({
        favorite: [{ providerID: "openai", modelID: "gpt-4o" }],
        recent: [],
      });
      await getModelSelectionLists();
      providersMock.mockResolvedValue(createProvidersResponse(WITHOUT_OPENAI));
      vi.useFakeTimers();

      startModelCatalogWarmup();
      const lists = await afterProviderWait(getModelSelectionLists(), 1);

      expect(lists.favorites).not.toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
    });

    it("reads the catalog again on every menu read inside the warm-up window", async () => {
      startModelCatalogWarmup();

      await getProviders();
      await getProviders();

      expect(providersMock).toHaveBeenCalledTimes(2);
    });

    it("hides the config model when OpenCode does not offer it", async () => {
      await setupMockModelFile({
        favorite: [{ providerID: "google", modelID: "gemini-pro" }],
        recent: [],
      });
      providersMock.mockResolvedValue(createProvidersResponse({ google: ["gemini-pro"] }));
      vi.useFakeTimers();

      const lists = await afterProviderWait(getModelSelectionLists(), 0);

      expect(lists.favorites).toEqual([{ providerID: "google", modelID: "gemini-pro" }]);
    });

    it("hides the config model when model.json cannot be read and OpenCode does not offer it", async () => {
      providersMock.mockResolvedValue(createProvidersResponse({ google: ["gemini-pro"] }));
      vi.useFakeTimers();

      const lists = await afterProviderWait(getModelSelectionLists(), 0);

      expect(lists.favorites).toEqual([]);
    });

    it("shows the config model when the catalog cannot be read", async () => {
      await setupMockModelFile({ favorite: [], recent: [] });
      providersMock.mockResolvedValue({ data: null, error: new Error("fetch failed") });

      const lists = await getModelSelectionLists();

      expect(lists.favorites).toEqual([{ providerID: "opencode", modelID: "big-pickle" }]);
    });

    it("keeps the stored model when the config model is not offered either", async () => {
      setCurrentModelState({ providerID: "openai", modelID: "gpt-4o", variant: "high" });
      providersMock.mockResolvedValue(createProvidersResponse({ google: ["gemini-pro"] }));

      const result = await reconcileStoredModelSelection({ forceCatalogRefresh: true });

      expect(result.storedModelReplaced).toBe(false);
      expect(setCurrentModelMock).not.toHaveBeenCalled();
      expect(getCurrentModelState()).toEqual({
        providerID: "openai",
        modelID: "gpt-4o",
        variant: "high",
      });
    });

    describe("getModelAvailability", () => {
      it("reports a listed model as offered", async () => {
        await expect(getModelAvailability("openai", "gpt-4o")).resolves.toBe("offered");
      });

      it("reports a model its listed provider no longer has", async () => {
        await expect(getModelAvailability("openai", "retired")).resolves.toBe("model-missing");
      });

      it("reports a provider still not listed after the wait", async () => {
        vi.useFakeTimers();
        providersMock.mockResolvedValue(createProvidersResponse(WITHOUT_OPENAI));

        const availability = getModelAvailability("openai", "gpt-4o");
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(availability).resolves.toBe("provider-missing");
      });

      it("reports unknown when the list cannot be read", async () => {
        providersMock.mockResolvedValue({ data: null, error: new Error("fetch failed") });

        await expect(getModelAvailability("openai", "gpt-4o")).resolves.toBe("unknown");
      });

      it("reports unknown when the server lists no models", async () => {
        providersMock.mockResolvedValue(createProvidersResponse({ openai: [] }));
        vi.useFakeTimers();

        await expect(afterProviderWait(getModelAvailability("openai", "gpt-4o"), 0)).resolves.toBe(
          "unknown",
        );
      });

      it("drops the cached catalog when a model is missing", async () => {
        await getProviders();
        expect(providersMock).toHaveBeenCalledTimes(1);

        await getModelAvailability("openai", "retired");
        await getProviders();

        expect(providersMock).toHaveBeenCalledTimes(3);
      });
    });

    describe("resolveModelToAdopt", () => {
      it("adopts a model OpenCode offers", async () => {
        await expect(
          resolveModelToAdopt({ providerID: "openai", modelID: "gpt-4o" }),
        ).resolves.toEqual({ providerID: "openai", modelID: "gpt-4o" });
      });

      it("adopts the config model instead of one its provider no longer lists", async () => {
        await expect(
          resolveModelToAdopt({ providerID: "openai", modelID: "retired" }),
        ).resolves.toEqual({ providerID: "opencode", modelID: "big-pickle" });
      });

      it("adopts the config model instead of one whose provider is gone", async () => {
        vi.useFakeTimers();
        providersMock.mockResolvedValue(createProvidersResponse(WITHOUT_OPENAI));

        const adopted = resolveModelToAdopt({ providerID: "openai", modelID: "gpt-4o" });
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(adopted).resolves.toEqual({ providerID: "opencode", modelID: "big-pickle" });
      });

      it("adopts a model whose provider is not listed yet inside the warm-up window", async () => {
        vi.useFakeTimers();
        await setupMockModelFile({ favorite: [], recent: [] });
        startModelCatalogWarmup();
        providersMock.mockResolvedValue(createProvidersResponse(WITHOUT_OPENAI));

        const adopted = resolveModelToAdopt({ providerID: "openai", modelID: "gpt-4o" });
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(adopted).resolves.toEqual({ providerID: "openai", modelID: "gpt-4o" });
      });

      it("adopts nothing when the config model is not offered either", async () => {
        providersMock.mockResolvedValue(createProvidersResponse({ openai: ["gpt-4o"] }));
        vi.useFakeTimers();

        await expect(
          afterProviderWait(resolveModelToAdopt({ providerID: "openai", modelID: "retired" }), 1),
        ).resolves.toBeNull();
      });

      it("adopts the model when the list cannot be read", async () => {
        providersMock.mockResolvedValue({ data: null, error: new Error("fetch failed") });

        await expect(
          resolveModelToAdopt({ providerID: "openai", modelID: "gpt-4o" }),
        ).resolves.toEqual({ providerID: "openai", modelID: "gpt-4o" });
      });
    });
  });
});

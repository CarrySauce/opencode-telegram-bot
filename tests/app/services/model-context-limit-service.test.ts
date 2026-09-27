import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { providersMock, getMissingExpectedProvidersMock, readProvidersWhenListedMock } = vi.hoisted(
  () => ({
    providersMock: vi.fn(),
    getMissingExpectedProvidersMock: vi.fn(),
    readProvidersWhenListedMock: vi.fn(),
  }),
);

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getMissingExpectedProviders: getMissingExpectedProvidersMock,
  readProvidersWhenListed: readProvidersWhenListedMock,
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    config: {
      providers: providersMock,
    },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  __resetModelContextLimitCacheForTests,
  DEFAULT_CONTEXT_LIMIT,
  getModelContextLimit,
  waitForModelContextLimit,
} from "../../../src/app/services/model-context-limit-service.js";

function createProvidersResponse(limitsByModel: Record<string, number>) {
  const modelsByProvider = new Map<string, Record<string, { limit: { context: number } }>>();

  for (const [key, context] of Object.entries(limitsByModel)) {
    const [providerID, modelID] = key.split("/") as [string, string];
    const models = modelsByProvider.get(providerID) ?? {};
    models[modelID] = { limit: { context } };
    modelsByProvider.set(providerID, models);
  }

  return {
    data: {
      providers: Array.from(modelsByProvider, ([id, models]) => ({ id, models })),
    },
    error: null,
  };
}

describe("app/services/model-context-limit-service", () => {
  beforeEach(() => {
    __resetModelContextLimitCacheForTests();
    providersMock.mockReset();
    providersMock.mockResolvedValue(createProvidersResponse({ "openai/gpt-4o": 128000 }));
    getMissingExpectedProvidersMock.mockReset();
    getMissingExpectedProvidersMock.mockResolvedValue([]);
    readProvidersWhenListedMock.mockReset();
    readProvidersWhenListedMock.mockResolvedValue(
      createProvidersResponse({ "openai/gpt-4o": 128000, "commandcode/deepseek-v4": 64000 }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the model's context limit and caches it", async () => {
    await expect(getModelContextLimit("openai", "gpt-4o")).resolves.toBe(128000);
    await expect(getModelContextLimit("openai", "gpt-4o")).resolves.toBe(128000);

    expect(providersMock).toHaveBeenCalledTimes(1);
  });

  it("does not keep a providers list without models", async () => {
    providersMock.mockResolvedValueOnce(createProvidersResponse({}));

    await expect(getModelContextLimit("openai", "gpt-4o")).resolves.toBe(DEFAULT_CONTEXT_LIMIT);
    await expect(getModelContextLimit("openai", "gpt-4o")).resolves.toBe(128000);

    expect(providersMock).toHaveBeenCalledTimes(2);
  });

  it("keeps limits cached before an empty providers list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await getModelContextLimit("openai", "gpt-4o");

    vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
    providersMock.mockResolvedValueOnce(createProvidersResponse({}));

    await expect(getModelContextLimit("anthropic", "claude")).resolves.toBe(DEFAULT_CONTEXT_LIMIT);
    await expect(getModelContextLimit("openai", "gpt-4o")).resolves.toBe(128000);
  });

  it("returns the default limit for a model the list does not name", async () => {
    await expect(getModelContextLimit("anthropic", "claude")).resolves.toBe(DEFAULT_CONTEXT_LIMIT);
  });

  it("reads a list lacking expected providers again on the next call", async () => {
    getMissingExpectedProvidersMock.mockResolvedValueOnce(["commandcode"]);
    providersMock.mockResolvedValueOnce(createProvidersResponse({ "openai/gpt-4o": 128000 }));
    providersMock.mockResolvedValue(
      createProvidersResponse({ "openai/gpt-4o": 128000, "commandcode/deepseek-v4": 64000 }),
    );

    await expect(getModelContextLimit("commandcode", "deepseek-v4")).resolves.toBe(
      DEFAULT_CONTEXT_LIMIT,
    );
    await expect(getModelContextLimit("commandcode", "deepseek-v4")).resolves.toBe(64000);

    expect(providersMock).toHaveBeenCalledTimes(2);
    expect(getMissingExpectedProvidersMock).toHaveBeenCalledWith(["openai"]);
  });

  it("keeps the limits of listed models from a list lacking expected providers", async () => {
    getMissingExpectedProvidersMock.mockResolvedValueOnce(["commandcode"]);

    await expect(getModelContextLimit("openai", "gpt-4o")).resolves.toBe(128000);
    await expect(getModelContextLimit("openai", "gpt-4o")).resolves.toBe(128000);

    expect(providersMock).toHaveBeenCalledTimes(1);
  });

  describe("waitForModelContextLimit", () => {
    it("returns a known limit without reading the list", async () => {
      await getModelContextLimit("openai", "gpt-4o");

      await expect(waitForModelContextLimit("openai", "gpt-4o")).resolves.toBe(128000);
      expect(readProvidersWhenListedMock).not.toHaveBeenCalled();
    });

    it("waits for the model's provider, then keeps its limit for the plain read", async () => {
      await expect(getModelContextLimit("commandcode", "deepseek-v4")).resolves.toBe(
        DEFAULT_CONTEXT_LIMIT,
      );

      await expect(waitForModelContextLimit("commandcode", "deepseek-v4")).resolves.toBe(64000);
      expect(readProvidersWhenListedMock).toHaveBeenCalledWith("commandcode");
      await expect(getModelContextLimit("commandcode", "deepseek-v4")).resolves.toBe(64000);
    });

    it("returns nothing when the model is still not listed after the wait", async () => {
      await expect(waitForModelContextLimit("anthropic", "claude")).resolves.toBeNull();
    });

    it("returns nothing when the list cannot be read", async () => {
      readProvidersWhenListedMock.mockResolvedValueOnce({
        data: null,
        error: new TypeError("fetch failed"),
      });

      await expect(waitForModelContextLimit("commandcode", "deepseek-v4")).resolves.toBeNull();
    });
  });
});

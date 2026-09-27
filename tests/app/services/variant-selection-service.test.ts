import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  getStoredModelMock: vi.fn(),
  readProvidersWhenListedMock: vi.fn(),
  getCurrentModelMock: vi.fn(),
  setCurrentModelMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: mocked.getStoredModelMock,
  readProvidersWhenListed: mocked.readProvidersWhenListedMock,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentModel: mocked.getCurrentModelMock,
  setCurrentModel: mocked.setCurrentModelMock,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: mocked.loggerInfoMock,
    warn: mocked.loggerWarnMock,
    error: vi.fn(),
  },
}));

import {
  getAvailableVariants,
  setCurrentVariant,
} from "../../../src/app/services/variant-selection-service.js";

describe("getAvailableVariants", () => {
  beforeEach(() => {
    mocked.readProvidersWhenListedMock.mockReset();
  });

  it("reads the variants once the model's provider is listed", async () => {
    mocked.readProvidersWhenListedMock.mockResolvedValue({
      data: {
        providers: [
          {
            id: "commandcode",
            models: { "deepseek-v4": { variants: { high: {}, low: { disabled: true } } } },
          },
        ],
      },
      error: null,
    });

    const variants = await getAvailableVariants("commandcode", "deepseek-v4");

    expect(mocked.readProvidersWhenListedMock).toHaveBeenCalledWith("commandcode");
    expect(variants).toEqual([
      { id: "default" },
      { id: "high", disabled: undefined },
      { id: "low", disabled: true },
    ]);
  });

  it("offers only the default variant when the provider is still not listed", async () => {
    mocked.readProvidersWhenListedMock.mockResolvedValue({
      data: { providers: [] },
      error: null,
    });

    await expect(getAvailableVariants("commandcode", "deepseek-v4")).resolves.toEqual([
      { id: "default" },
    ]);
  });
});

describe("setCurrentVariant", () => {
  beforeEach(() => {
    mocked.getStoredModelMock.mockReset();
    mocked.getCurrentModelMock.mockReset();
    mocked.setCurrentModelMock.mockReset();
    mocked.loggerWarnMock.mockReset();
    mocked.loggerInfoMock.mockReset();
  });

  it("persists the fallback model when settings have no currentModel", () => {
    mocked.getCurrentModelMock.mockReturnValue(undefined);
    mocked.getStoredModelMock.mockReturnValue({
      providerID: "opencode-go",
      modelID: "deepseek-v4-flash",
      variant: "default",
    });

    setCurrentVariant("low");

    expect(mocked.setCurrentModelMock).toHaveBeenCalledWith({
      providerID: "opencode-go",
      modelID: "deepseek-v4-flash",
      variant: "low",
    });
  });

  it("does not write when the fallback model has no provider or id", () => {
    mocked.getStoredModelMock.mockReturnValue({
      providerID: "",
      modelID: "",
      variant: "default",
    });

    setCurrentVariant("low");

    expect(mocked.setCurrentModelMock).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalled();
  });
});

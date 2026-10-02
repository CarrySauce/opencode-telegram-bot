import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkFolderPresence,
  collectFromPresentFolders,
} from "../../../src/app/services/folder-presence-service.js";

const mocked = vi.hoisted(() => ({
  serverVersion: "v2" as "v1" | "v2",
  fileListMock: vi.fn(),
  // Folders answering their own listing with a 500, and what each listing folder contains.
  failing: new Set<string>(),
  listings: new Map<string, string[]>(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  get opencodeServerVersion() {
    return mocked.serverVersion;
  },
  opencodeV2Client: { file: { list: mocked.fileListMock } },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function serverError(status: number): Error {
  return Object.assign(new Error(String(status)), {
    name: "ClientError",
    reason: "UnexpectedStatus",
    cause: { status },
  });
}

describe("app/services/folder-presence-service", () => {
  beforeEach(() => {
    mocked.serverVersion = "v2";
    mocked.failing = new Set();
    mocked.listings = new Map();
    mocked.fileListMock
      .mockReset()
      .mockImplementation(async ({ path }: { path: string }) =>
        mocked.failing.has(path)
          ? { data: undefined, error: serverError(500) }
          : { data: mocked.listings.get(path) ?? [], error: undefined },
      );
  });

  describe("checkFolderPresence", () => {
    it("is present when the server lists the folder", async () => {
      expect(await checkFolderPresence("/repo")).toBe("present");
    });

    it("is missing when the folder fails with a 500 and its parent has no such entry", async () => {
      mocked.failing.add("/projects/app");
      mocked.listings.set("/projects", ["other/"]);

      expect(await checkFolderPresence("/projects/app")).toBe("missing");
    });

    it("stays unknown when the parent still lists a folder that failed to answer", async () => {
      mocked.failing.add("D:\\Projects\\App");
      mocked.listings.set("D:\\Projects", ["..\\app\\"]);

      expect(await checkFolderPresence("D:\\Projects\\App")).toBe("unknown");
    });

    it("stays unknown on any failure other than a 500", async () => {
      mocked.fileListMock.mockResolvedValue({ data: undefined, error: serverError(503) });

      expect(await checkFolderPresence("/repo")).toBe("unknown");
      expect(mocked.fileListMock).toHaveBeenCalledTimes(1);
    });

    it("stays unknown when the parent listing fails for another reason", async () => {
      mocked.fileListMock.mockImplementation(async ({ path }: { path: string }) => ({
        data: undefined,
        error: path === "/projects/app" ? serverError(500) : new Error("fetch failed"),
      }));

      expect(await checkFolderPresence("/projects/app")).toBe("unknown");
    });

    it("walks up past a deleted parent and looks there for the next segment", async () => {
      mocked.failing = new Set(["/a/b/c", "/a/b"]);
      mocked.listings.set("/a", ["c/"]);

      expect(await checkFolderPresence("/a/b/c")).toBe("missing");
    });

    it("stays unknown when the nearest listing ancestor still has the next segment", async () => {
      mocked.failing = new Set(["/a/b/c", "/a/b"]);
      mocked.listings.set("/a", ["b/"]);

      expect(await checkFolderPresence("/a/b/c")).toBe("unknown");
    });

    it("stays unknown when nothing up to the root lists", async () => {
      mocked.failing = new Set(["/a", "/"]);

      expect(await checkFolderPresence("/a")).toBe("unknown");
    });

    it("never asks about the global project", async () => {
      expect(await checkFolderPresence("/")).toBe("present");
      expect(mocked.fileListMock).not.toHaveBeenCalled();
    });

    it("never asks a V1 server", async () => {
      mocked.serverVersion = "v1";

      expect(await checkFolderPresence("/repo")).toBe("unknown");
      expect(mocked.fileListMock).not.toHaveBeenCalled();
    });
  });

  describe("collectFromPresentFolders", () => {
    it("asks for more until enough items remain", async () => {
      mocked.failing.add("/gone");
      const items = ["/gone", "/gone", "/one", "/two", "/three"];
      const fetchItems = vi.fn(async (limit: number) => items.slice(0, limit));

      const visible = await collectFromPresentFolders(fetchItems, (item) => item, 3);

      expect(visible).toEqual(["/one", "/two", "/three"]);
      expect(fetchItems.mock.calls.map(([limit]) => limit)).toEqual([3, 6]);
    });

    it("stops when the source has no more", async () => {
      mocked.failing.add("/gone");
      const fetchItems = vi.fn(async () => ["/gone", "/one"]);

      expect(await collectFromPresentFolders(fetchItems, (item) => item, 5)).toEqual(["/one"]);
      expect(fetchItems).toHaveBeenCalledTimes(1);
    });
  });
});

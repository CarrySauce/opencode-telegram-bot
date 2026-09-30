import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRecentSessions } from "../../../src/app/services/recent-sessions-service.js";

const mocked = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), status: vi.fn(), questions: vi.fn(), permissions: vi.fn(),
  attached: null as { id: string; directory: string } | null, warn: vi.fn(),
}));
vi.mock("../../../src/opencode/client.js", () => ({ opencodeClient: {
  experimental: { session: { list: mocked.list } },
  session: { get: mocked.get, status: mocked.status },
  question: { list: mocked.questions }, permission: { list: mocked.permissions },
} }));
vi.mock("../../../src/app/stores/settings-store.js", () => ({ getCurrentSession: () => mocked.attached }));
vi.mock("../../../src/utils/logger.js", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: mocked.warn, error: vi.fn() } }));

const session = (id: string, directory: string, updated: number) => ({
  id, directory, title: id, time: { created: updated, updated }, project: null,
});

describe("cross-project recent session snapshot", () => {
  beforeEach(() => {
    mocked.attached = null;
    mocked.list.mockReset(); mocked.get.mockReset(); mocked.status.mockReset();
    mocked.questions.mockReset(); mocked.permissions.mockReset(); mocked.warn.mockReset();
    mocked.questions.mockResolvedValue({ data: [], error: null });
    mocked.permissions.mockResolvedValue({ data: [], error: null });
    mocked.status.mockResolvedValue({ data: {}, error: null });
  });

  it("queries global root sessions and snapshots each directory with status precedence", async () => {
    mocked.list.mockResolvedValue({ data: [session("a", "/one", 4), session("b", "/two", 3), session("c", "/one", 2)], error: null });
    mocked.status.mockImplementation(async ({ directory }: { directory: string }) => ({
      data: directory === "/one" ? { a: { type: "busy" }, c: { type: "retry" } } : { b: { type: "idle" } }, error: null,
    }));
    mocked.questions.mockImplementation(async ({ directory }: { directory: string }) => ({
      data: directory === "/one" ? [{ sessionID: "a" }] : [], error: null,
    }));
    mocked.permissions.mockImplementation(async ({ directory }: { directory: string }) => ({
      data: directory === "/one" ? [{ sessionID: "a" }] : [{ sessionID: "b" }], error: null,
    }));

    const rows = await loadRecentSessions(3);

    expect(mocked.list).toHaveBeenCalledWith({ roots: true, limit: 3 });
    expect(mocked.status).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => row.status)).toEqual(["question", "permission", "running"]);
  });

  it("attributes a detached child permission through its parent chain to a listed root", async () => {
    mocked.list.mockResolvedValue({ data: [session("root", "/other", 3)], error: null });
    mocked.permissions.mockResolvedValue({ data: [{ sessionID: "grandchild" }], error: null });
    mocked.get.mockImplementation(async ({ sessionID }: { sessionID: string }) => ({
      data: { parentID: sessionID === "grandchild" ? "child" : "root" }, error: null,
    }));

    expect((await loadRecentSessions(10))[0]?.status).toBe("permission");
    expect(mocked.get).toHaveBeenCalledTimes(2);
  });

  it("attributes a subagent's pending question through its parent chain to a listed root", async () => {
    mocked.list.mockResolvedValue({ data: [session("root", "/other", 3)], error: null });
    mocked.questions.mockResolvedValue({ data: [{ sessionID: "child" }], error: null });
    mocked.get.mockResolvedValue({ data: { parentID: "root" }, error: null });

    expect((await loadRecentSessions(10))[0]?.status).toBe("question");
  });

  it("retains an older attached root inside the limit", async () => {
    mocked.attached = { id: "old", directory: "/old" };
    mocked.list.mockResolvedValue({ data: [session("new", "/new", 10), session("next", "/new", 9)], error: null });
    mocked.get.mockResolvedValue({ data: session("old", "/old", 1), error: null });

    expect((await loadRecentSessions(2)).map(({ session }) => session.id)).toEqual(["new", "old"]);
  });

  it("shows idle and an empty list without a selected project", async () => {
    mocked.list.mockResolvedValueOnce({ data: [session("idle", "/repo", 1)], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    expect((await loadRecentSessions(10))[0]?.status).toBe("idle");
    expect(await loadRecentSessions(10)).toEqual([]);
  });

  it("keeps the list and falls back to run status when a folder's pending lookups fail", async () => {
    const failure = { data: undefined, error: new Error("UnexpectedStatus: 500") };
    mocked.list.mockResolvedValue({ data: [session("gone", "/deleted", 3), session("q", "/live", 2), session("p", "/live", 1)], error: null });
    mocked.status.mockImplementation(async ({ directory }: { directory: string }) => ({
      data: directory === "/deleted" ? { gone: { type: "busy" } } : {}, error: null,
    }));
    mocked.questions.mockImplementation(async ({ directory }: { directory: string }) =>
      directory === "/deleted" ? failure : { data: [{ sessionID: "q" }], error: null });
    mocked.permissions.mockImplementation(async ({ directory }: { directory: string }) =>
      directory === "/deleted" ? failure : { data: [{ sessionID: "p" }], error: null });

    const rows = await loadRecentSessions(3);

    expect(rows.map(({ session, status }) => [session.id, status])).toEqual([
      ["gone", "running"], ["q", "question"], ["p", "permission"],
    ]);
    expect(mocked.warn).toHaveBeenCalledTimes(2);
  });

  it("shows idle or a found pending request when a folder's run-status lookup fails", async () => {
    mocked.list.mockResolvedValue({ data: [session("asked", "/repo", 2), session("quiet", "/repo", 1)], error: null });
    mocked.status.mockResolvedValue({ data: undefined, error: new Error("UnexpectedStatus: 500") });
    mocked.questions.mockResolvedValue({ data: [{ sessionID: "asked" }], error: null });

    expect((await loadRecentSessions(10)).map((row) => row.status)).toEqual(["question", "idle"]);
  });

  it("shows idle for a folder whose every lookup fails", async () => {
    const failure = { data: undefined, error: new Error("UnexpectedStatus: 500") };
    mocked.list.mockResolvedValue({ data: [session("gone", "/deleted", 1)], error: null });
    mocked.status.mockResolvedValue(failure);
    mocked.questions.mockResolvedValue(failure);
    mocked.permissions.mockResolvedValue(failure);

    expect(await loadRecentSessions(10)).toEqual([{ session: session("gone", "/deleted", 1), status: "idle" }]);
    expect(mocked.warn).toHaveBeenCalledTimes(3);
  });

  it("keeps a found permission when only the question lookup fails", async () => {
    mocked.list.mockResolvedValue({ data: [session("p", "/repo", 1)], error: null });
    mocked.questions.mockResolvedValue({ data: undefined, error: new Error("UnexpectedStatus: 500") });
    mocked.permissions.mockResolvedValue({ data: [{ sessionID: "p" }], error: null });

    expect((await loadRecentSessions(10))[0]?.status).toBe("permission");
  });

  it("fails when the session list itself cannot be loaded", async () => {
    const error = new Error("UnexpectedStatus: 500");
    mocked.list.mockResolvedValue({ data: undefined, error });

    await expect(loadRecentSessions(10)).rejects.toBe(error);
  });
});

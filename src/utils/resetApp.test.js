import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  closeFormexDb: vi.fn(),
}));

vi.mock("./formexApi.js", () => ({
  closeFormexDb: mocks.closeFormexDb,
}));

const { runOneTimeMigrationReset } = await import("./resetApp.js");

describe("application data reset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes this tab's Formex connection before deleting its database", async () => {
    const calls = [];
    let finishClosing;
    mocks.closeFormexDb.mockImplementation(() => new Promise((resolve) => {
      calls.push("close");
      finishClosing = resolve;
    }));

    const deleteDatabase = vi.fn(() => {
      calls.push("delete");
      const request = {};
      queueMicrotask(() => request.onsuccess?.());
      return request;
    });
    vi.stubGlobal("indexedDB", { deleteDatabase });

    const reset = runOneTimeMigrationReset();
    await Promise.resolve();
    expect(deleteDatabase).not.toHaveBeenCalled();

    finishClosing();
    await reset;

    expect(calls).toEqual(["close", "delete"]);
    expect(deleteDatabase).toHaveBeenCalledWith("formex-cache");
  });
});

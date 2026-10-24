/** 保存文档检查只相信明确结果，并限制长历史的单次请求大小。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSavedDocuments } from "../src/siyuan/saved";
import { kernelPost } from "../src/siyuan/api";

vi.mock("../src/siyuan/api", () => ({ kernelPost: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("saved document availability", () => {
  it("deduplicates IDs and preserves unknown or malformed results", async () => {
    const existing = "20261014100000-aaaaaaa", missing = "20261014100000-bbbbbbb", unknown = "20261014100000-ccccccc";
    vi.mocked(kernelPost).mockResolvedValue({ [existing]: true, [missing]: false, [unknown]: null });
    expect(await checkSavedDocuments([existing, missing, unknown, existing, "", "invalid"])).toEqual(new Map([[existing, true], [missing, false]]));
    expect(kernelPost).toHaveBeenCalledExactlyOnceWith("/api/block/checkBlocksExist", { ids: [existing, missing, unknown] }, 8000);
  });

  it("does not treat a failed request as missing documents", async () => {
    vi.mocked(kernelPost).mockRejectedValue(new Error("断线"));
    await expect(checkSavedDocuments(["20261014100000-aaaaaaa"])).rejects.toThrow("断线");
  });

  it("batches a long history and avoids requests for an empty list", async () => {
    expect(await checkSavedDocuments([])).toEqual(new Map());
    expect(kernelPost).not.toHaveBeenCalled();
    vi.mocked(kernelPost).mockImplementation(async (_path, payload) => Object.fromEntries((payload as { ids: string[] }).ids.map(id => [id, true])));
    const ids = Array.from({ length: 260 }, (_, index) => `20261014100000-${index.toString(36).padStart(7, "a")}`);
    expect((await checkSavedDocuments(ids)).size).toBe(260);
    expect(vi.mocked(kernelPost).mock.calls.map(([, payload]) => (payload as { ids: string[] }).ids.length)).toEqual([128, 128, 4]);
  });
});

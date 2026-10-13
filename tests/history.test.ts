// @vitest-environment jsdom
/** 文章历史持久化、升级迁移、删除与恢复缓存的回归测试。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureHistoryStore, type CaptureHistory } from "../src/article/history";
import type { CaptureDraft } from "../src/article/draft";

function draft(markdown = "原文"): CaptureDraft {
  return { version: 1, updatedAt: Date.now(), url: "https://example.com/post", article: { url: "https://example.com/post", title: "标题", markdown, capturedAt: "2026-10-13T01:00:00Z" },
    markdown, reviewedMarkdown: "", imageDecisions: [], targetDocumentId: "doc", perspective: "original", savedDocumentId: "" };
}

describe("capture history storage", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("merges progress writes and flushes the latest recovered article on close", async () => {
    const write = vi.fn(), store = new CaptureHistoryStore(async () => null, write, vi.fn(), localStorage);
    const id = store.add(draft()); await store.flush(); write.mockClear();
    for (let i = 0; i < 10; i++) {
      store.update(id, draft(`进度 ${i}`), 5000);
      const reopened = new CaptureHistoryStore(async () => null, async () => undefined, vi.fn(), localStorage);
      await reopened.load(); expect(reopened.entries[0].draft.markdown).toBe(`进度 ${i}`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(write).toHaveBeenCalledTimes(2);
    store.update(id, draft("最后进度"), 5000); await store.flush();
    store.update(id, draft("最后进度")); await Promise.all([store.flush(), store.flush()]);
    expect(write).toHaveBeenCalledTimes(3); expect(write.mock.calls.at(-1)![0].entries[0].draft.markdown).toBe("最后进度");
  });

  it("retains separate versions for repeated captures and restores reviewed article state", async () => {
    let stored: unknown;
    const store = new CaptureHistoryStore(async () => null, async history => { stored = history; }, vi.fn(), localStorage);
    const first = store.add(draft()), second = store.add(draft("再次抓取"));
    store.update(first, { ...draft(), markdown: "处理稿", reviewedMarkdown: "处理稿", textReviewed: true, savedDocumentId: "doc", reviewInfo: { model: "test", perspective: "original", completedAt: "now", summary: "摘要" } });
    await store.flush();
    const reopened = new CaptureHistoryStore(async () => stored, async () => undefined, vi.fn()); await reopened.load();
    expect(reopened.entries.map(entry => entry.id)).toEqual([second, first]);
    expect(reopened.entries[1].draft).toMatchObject({ markdown: "处理稿", article: { markdown: "原文" }, savedDocumentId: "doc", textReviewed: true });
  });

  it("migrates the old single draft once across reloads", async () => {
    let stored: unknown;
    const store = new CaptureHistoryStore(async () => null, async history => { stored = history; }, vi.fn());
    const id = store.migrate(draft()); expect(store.migrate(draft())).toBe(id); await store.flush();
    const reopened = new CaptureHistoryStore(async () => stored, async () => undefined, vi.fn()); await reopened.load();
    expect(reopened.migrate(draft())).toBe(id); expect(reopened.entries).toHaveLength(1);
  });

  it("does not resurrect deleted entries from a later update or the recovery cache", async () => {
    let stored: unknown;
    const store = new CaptureHistoryStore(async () => null, async history => { stored = history; }, vi.fn(), localStorage, "workspace");
    const id = store.add(draft()); await store.flush(); const old = stored;
    store.remove(id); store.update(id, draft("迟到的审阅稿"));
    const reopened = new CaptureHistoryStore(async () => old, async () => undefined, vi.fn(), localStorage, "workspace"); await reopened.load();
    expect(reopened.entries).toEqual([]); expect(reopened.migrate({ ...draft(), historyId: id })).toBeUndefined();
    await store.flush(); expect((stored as CaptureHistory).entries).toEqual([]);
  });

  it("keeps deletion ordered after a slow earlier write", async () => {
    const snapshots: number[] = []; let finish!: () => void;
    const store = new CaptureHistoryStore(async () => null, async history => {
      if (history.entries.length) await new Promise<void>(resolve => { finish = resolve; });
      snapshots.push(history.entries.length);
    }, vi.fn());
    const id = store.add(draft()); const first = store.flush(); await Promise.resolve(); await Promise.resolve();
    store.remove(id); const second = store.flush(); finish(); await first; await second;
    expect(snapshots).toEqual([1, 0]);
  });

  it("retains valid entries from a partially corrupted history file", async () => {
    const stored = { version: 1, updatedAt: 1, entries: [{ id: "a", capturedAt: 1, draft: draft() }, { id: "bad", draft: null }, { id: "a", capturedAt: 1, draft: draft() }] };
    const store = new CaptureHistoryStore(async () => stored, async () => undefined, vi.fn()); await store.load();
    expect(store.entries.map(entry => entry.id)).toEqual(["a"]);
  });

  it("isolates workspaces and removes only its own cache on uninstall", async () => {
    const write = vi.fn();
    const store = new CaptureHistoryStore(async () => null, write, vi.fn(), localStorage, "a"); store.add(draft());
    const other = new CaptureHistoryStore(async () => null, write, vi.fn(), localStorage, "b"); await other.load(); expect(other.entries).toEqual([]);
    localStorage.setItem("another-plugin", "keep"); store.dispose(); store.add(draft()); await store.flush(); await vi.advanceTimersByTimeAsync(500);
    expect(write).not.toHaveBeenCalled(); expect(store.entries).toEqual([]);
    expect(localStorage.getItem("noosphere:capture-history:v1:a")).toBeNull(); expect(localStorage.getItem("another-plugin")).toBe("keep");
  });

  it("keeps the in-memory history available for retry after a disk failure", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const store = new CaptureHistoryStore(async () => null, write, vi.fn()); store.add(draft());
    await expect(store.flush()).rejects.toThrow("offline"); await store.flush();
    expect(write).toHaveBeenCalledTimes(2); expect(store.entries).toHaveLength(1);
  });

  it("captures articles in HTTP browser frontends without crypto.randomUUID", async () => {
    vi.stubGlobal("crypto", {});
    const store = new CaptureHistoryStore(async () => null, async () => undefined, vi.fn());
    const first = store.add(draft()), second = store.add(draft());
    expect(first).toBeTruthy(); expect(first).not.toBe(second); expect(store.entries).toHaveLength(2);
    await store.flush();
  });
});

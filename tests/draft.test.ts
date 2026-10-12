// @vitest-environment jsdom
/** 草稿恢复与异步保存乱序的回归验证。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureDraftStore, type CaptureDraft } from "../src/article/draft";

function draft(markdown = "# 草稿"): CaptureDraft {
  return { version: 1, updatedAt: Date.now(), url: "https://example.com/post", article: { url: "https://example.com/post", title: "测试文章", markdown }, markdown,
    reviewedMarkdown: "", imageDecisions: [], targetDocumentId: "doc", perspective: "original", savedDocumentId: "" };
}

describe("automatic draft storage", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("recovers typing before the delayed disk write or window close", async () => {
    const store = new CaptureDraftStore(async () => null, async () => undefined, vi.fn(), localStorage);
    store.update(draft("手动修改"));
    const reopened = new CaptureDraftStore(async () => null, async () => undefined, vi.fn(), localStorage);
    await reopened.load();
    expect(reopened.current?.markdown).toBe("手动修改");
    await store.flush();
  });

  it("keeps the latest write after a slow earlier request", async () => {
    let finish: () => void = () => undefined;
    const persisted: string[] = [];
    const store = new CaptureDraftStore(async () => null, async value => {
      if (!persisted.length && value.markdown === "旧正文") await new Promise<void>(resolve => { finish = resolve; });
      persisted.push(value.markdown);
    }, vi.fn());
    store.update(draft("旧正文"));
    const first = store.flush();
    await Promise.resolve(); await Promise.resolve();
    store.update(draft("新正文"));
    const second = store.flush();
    finish(); await first; await second;
    expect(persisted).toEqual(["旧正文", "新正文"]);
  });

  it("uses the newer recovery cache even when updates share a timestamp", async () => {
    const original = draft("旧正文");
    const store = new CaptureDraftStore(async () => original, async () => undefined, vi.fn(), localStorage);
    await store.load(); store.update({ ...original, markdown: "新正文" });
    const reopened = new CaptureDraftStore(async () => original, async () => undefined, vi.fn(), localStorage);
    await reopened.load();
    expect(reopened.current?.markdown).toBe("新正文");
    await store.flush();
  });

  it("can retry a failed disk write without losing the draft", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const store = new CaptureDraftStore(async () => null, write, vi.fn(), localStorage);
    store.update(draft("待保存正文"));
    await expect(store.flush()).rejects.toThrow("offline");
    await store.flush();
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: "待保存正文" }));
  });

  it("keeps recovery drafts separate when switching SiYuan workspaces", async () => {
    const first = new CaptureDraftStore(async () => null, async () => undefined, vi.fn(), localStorage, "workspace-a");
    first.update(draft("工作空间 A 的文章"));
    const other = new CaptureDraftStore(async () => null, async () => undefined, vi.fn(), localStorage, "workspace-b");
    await other.load(); expect(other.current).toBeNull();
    await first.flush();
  });

  it("ignores invalid files and restores image choices from a valid file", async () => {
    const store = new CaptureDraftStore(async () => ({ version: 1, imageDecisions: null }), async () => undefined, vi.fn());
    await store.load(); expect(store.current).toBeNull();
    const value = { ...draft(), reviewedMarkdown: "正文 ![图](https://example.com/a.png)", imageDecisions: [{ full: "![图](https://example.com/a.png)", alt: "图", url: "https://example.com/a.png", description: "广告", remove: true, recommendedRemove: true }] };
    const restored = new CaptureDraftStore(async () => value, async () => undefined, vi.fn());
    await restored.load(); expect(restored.current?.imageDecisions[0].remove).toBe(true);
    expect(restored.current?.reviewedMarkdown).toBe(value.reviewedMarkdown);
  });

  it("removes this workspace's recovery cache and stops scheduled writes after uninstall", async () => {
    const write = vi.fn();
    const store = new CaptureDraftStore(async () => null, write, vi.fn(), localStorage, "workspace-a");
    store.update(draft());
    localStorage.setItem("noosphere:capture-draft:v1:workspace-b", "other workspace");
    localStorage.setItem("another-plugin", "keep");
    store.dispose(); store.update(draft("late callback")); await store.flush(); await vi.advanceTimersByTimeAsync(1000);
    expect(store.current).toBeNull(); expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem("noosphere:capture-draft:v1:workspace-a")).toBeNull();
    expect(localStorage.getItem("noosphere:capture-draft:v1:workspace-b")).toBe("other workspace");
    expect(localStorage.getItem("another-plugin")).toBe("keep");
  });
});

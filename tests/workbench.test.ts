// @vitest-environment jsdom
/** 以思源接口替身验证真实工作台关闭、恢复、抓取失败及图片取舍。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ files: new Map<string, unknown>(), dialogs: [] as Array<{ destroy(): void }>, messages: vi.fn() }));
vi.mock("siyuan", () => ({
  Plugin: class {
    app = {};
    addIcons(): void {}
    addCommand(): void {}
    addTopBar({ callback }: { callback: () => void }): HTMLButtonElement {
      let button = document.querySelector<HTMLButtonElement>("#entry");
      if (!button) { button = document.createElement("button"); button.id = "entry"; document.body.append(button); }
      button.onclick = callback;
      return button;
    }
    async loadData(name: string): Promise<unknown> { return structuredClone(fixtures.files.get(name)); }
    async saveData(name: string, value: unknown): Promise<{ code: number }> { fixtures.files.set(name, structuredClone(value)); return { code: 0 }; }
  },
  Dialog: class {
    element = document.createElement("div");
    constructor(private options: { content: string; destroyCallback(): void }) {
      this.element.innerHTML = '<div class="b3-dialog__header"></div>' + options.content;
      document.body.append(this.element); fixtures.dialogs.push(this);
    }
    destroy(): void { this.options.destroyCallback(); this.element.remove(); }
  },
  getActiveEditor: () => null, openTab: vi.fn(), showMessage: fixtures.messages, confirm: vi.fn(),
}));
vi.mock("../src/review/provider", () => ({ listAvailableModels: vi.fn(), reviewArticleDetailed: vi.fn() }));
vi.mock("../src/images/localize", () => ({ localizeMarkdownImages: vi.fn() }));
vi.mock("../src/siyuan/writer", () => ({ validateTargetDocument: vi.fn(), appendArticle: vi.fn() }));

import NoospherePlugin from "../src/index";
import { DEFAULT_SETTINGS } from "../src/types";
import { reviewArticleDetailed } from "../src/review/provider";
import { imageInventory } from "../src/review/images";
import { localizeMarkdownImages } from "../src/images/localize";
import { appendArticle } from "../src/siyuan/writer";
import { type CaptureDraft, DRAFT_STORAGE_NAME } from "../src/article/draft";

const article = { url: "https://example.com/article", title: "文章标题", markdown: "# 文章标题\n\n原文 ![图](https://example.com/photo.png)" };
function input(name: string, value: string): void {
  const field = document.querySelector<HTMLInputElement>(`[data-field="${name}"]`)!;
  field.value = value; field.dispatchEvent(new Event("input"));
}
function stored(): CaptureDraft { return fixtures.files.get(DRAFT_STORAGE_NAME) as CaptureDraft; }
function click(name: string): void { document.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!.click(); }
async function ready(): Promise<void> { await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="toggleSettings"]')?.disabled).toBe(false)); }
async function launch(): Promise<NoospherePlugin> {
  const plugin = new NoospherePlugin(); await plugin.onload(); document.querySelector<HTMLButtonElement>("#entry")!.click(); return plugin;
}
async function scrape(): Promise<void> { input("url", article.url); click("scrape"); await ready(); }

describe("workbench regression", () => {
  beforeEach(() => {
    fixtures.files.clear(); fixtures.dialogs.length = 0; fixtures.messages.mockClear(); document.body.replaceChildren(); localStorage.clear();
    fixtures.files.set("settings.json", { ...DEFAULT_SETTINGS, firecrawlKey: "test", modelKey: "test", modelName: "test", reviewPerspective: "original" });
    Object.assign(window, { Lute: { New: () => ({ ProtylePreviewStr: () => "<h1>文章标题</h1><p>原文</p><img src='/photo.png'>" }) } });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ success: true, data: { markdown: article.markdown, metadata: { title: article.title } } }) } }) })));
  });
  afterEach(() => { fixtures.dialogs.at(-1)?.destroy(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("restores a read-only article and the destination after closing and restarting the plugin", async () => {
    const plugin = await launch(); await scrape();
    expect(document.querySelector<HTMLElement>('[data-role="articlePreview"]')?.hidden).toBe(false);
    expect(document.querySelector('[data-action="edit"], [data-field="markdown"]')).toBeNull();
    input("targetDocumentId", "20261012100000-abcdefg");
    fixtures.dialogs.at(-1)!.destroy();
    document.querySelector<HTMLButtonElement>("#entry")!.click();
    expect(stored().markdown).toBe(article.markdown);
    plugin.onunload(); await Promise.resolve(); await Promise.resolve();
    await launch();
    expect(document.querySelector<HTMLInputElement>('[data-field="targetDocumentId"]')!.value).toBe("20261012100000-abcdefg");
    expect(document.querySelector<HTMLElement>('[data-role="articlePreview"]')!.hidden).toBe(false);
  });

  it("preserves the current article when a changed URL fails to scrape", async () => {
    await launch(); await scrape();
    input("url", "https://example.com/fails");
    expect(stored().markdown).toBe(article.markdown);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); })); click("scrape"); await ready();
    expect((fixtures.files.get(DRAFT_STORAGE_NAME) as CaptureDraft).markdown).toBe(article.markdown);
    expect(document.querySelector<HTMLElement>('[data-role="articlePreview"]')!.hidden).toBe(false);
  });

  it("restores the reviewed draft and image choices after closing", async () => {
    const decision = { full: "![图](https://example.com/photo.png)", alt: "图", url: "https://example.com/photo.png", description: "广告图", remove: true, recommendedRemove: true };
    vi.mocked(reviewArticleDetailed).mockResolvedValueOnce({ article, markdown: "# 审阅稿\n" + decision.full, imageDecisions: [decision], imageWarnings: [], imagesReviewed: 1, metadataAccepted: [] } as never);
    await launch(); await scrape(); click("review"); await ready(); fixtures.dialogs.at(-1)!.destroy();
    document.querySelector<HTMLButtonElement>("#entry")!.click();
    const checkbox = document.querySelector<HTMLInputElement>('[data-role="imageDecisionList"] input')!;
    expect(checkbox.checked).toBe(true);
    expect(stored().markdown).not.toContain("photo.png");
    checkbox.checked = false; checkbox.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored().markdown).toContain("photo.png"));
  });

  it("keeps localized content available when saving the document fails", async () => {
    vi.mocked(localizeMarkdownImages).mockResolvedValueOnce({ markdown: "# 文章标题\n![图](assets/local.png)", localized: 1, warnings: [] });
    vi.mocked(appendArticle).mockRejectedValueOnce(new Error("write failed"));
    await launch(); await scrape(); input("targetDocumentId", "20261012100000-abcdefg"); click("save"); await ready();
    const stored = fixtures.files.get(DRAFT_STORAGE_NAME) as CaptureDraft;
    expect(stored.article?.title).toBe(article.title); expect(stored.markdown).toContain("assets/local.png"); expect(stored.savedDocumentId).toBe("");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(false);
  });

  it("retains saved articles on reopening and prevents an accidental second save", async () => {
    vi.mocked(localizeMarkdownImages).mockResolvedValueOnce({ markdown: article.markdown, localized: 0, warnings: [] });
    vi.mocked(appendArticle).mockResolvedValueOnce("inserted");
    await launch(); await scrape(); input("targetDocumentId", "20261012100000-abcdefg"); click("save"); await ready(); fixtures.dialogs.at(-1)!.destroy();
    document.querySelector<HTMLButtonElement>("#entry")!.click();
    expect(document.querySelector<HTMLElement>('[data-role="articlePreview"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-role="saved"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(true);
  });

  it("persists an in-flight capture even when its dialog is closed before completion", async () => {
    let finish: (value: unknown) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { finish = resolve; })));
    await launch(); input("url", article.url); click("scrape");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    fixtures.dialogs.at(-1)!.destroy();
    finish({ ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ success: true, data: { markdown: article.markdown, metadata: { title: article.title } } }) } }) });
    await vi.waitFor(() => expect((fixtures.files.get(DRAFT_STORAGE_NAME) as CaptureDraft)?.article?.title).toBe(article.title));
    document.querySelector<HTMLButtonElement>("#entry")!.click();
    expect(stored().markdown).toBe(article.markdown);
  });

  it("reviews the complete source through the sole AI entry even when an old draft has partial results", async () => {
    const decisions = imageInventory(article.markdown, article.url);
    fixtures.files.set(DRAFT_STORAGE_NAME, { version: 1, updatedAt: Date.now(), article, url: article.url, markdown: "# 旧审阅稿", reviewedMarkdown: "# 旧审阅稿", imageDecisions: decisions, targetDocumentId: "", perspective: "original", savedDocumentId: "" });
    vi.mocked(reviewArticleDetailed).mockResolvedValueOnce({ article, markdown: article.markdown, summary: "摘要", imageDecisions: decisions, imagesReviewed: 1, imageWarnings: [], metadataAccepted: [] });
    await launch();
    expect(document.querySelector('[data-action="reviewImages"]')).toBeNull();
    click("review"); await ready();
    expect(reviewArticleDetailed).toHaveBeenCalledWith(expect.objectContaining({ markdown: article.markdown }), expect.any(Object), article.markdown, expect.objectContaining({ onImageProgress: expect.any(Function) }));
    expect(stored().markdown).toBe(article.markdown);
  });

  it("retains the text result and completed images if the workbench closes during vision review", async () => {
    let finish: () => void = () => undefined;
    const result = { article, markdown: "# 已审阅正文\n" + article.markdown, summary: "摘要", imageDecisions: imageInventory(article.markdown, article.url), imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] };
    const decisions = result.imageDecisions.map(item => ({ ...item, status: "reviewed" as const, description: "相关配图" }));
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      options?.onTextReviewed?.(result);
      options?.onImageProgress?.({ decisions, reviewed: 1, warnings: [] });
      await new Promise<void>(resolve => { finish = resolve; });
      return { ...result, imageDecisions: decisions, imagesReviewed: 1 };
    });
    await launch(); await scrape(); click("review");
    await vi.waitFor(() => expect(document.querySelector('[data-role="imageDecisionCount"]')!.textContent).toContain("已审阅 1"));
    expect(document.querySelector('[data-role="reviewState"]')!.textContent).toBe("审阅中");
    expect(document.querySelector<HTMLButtonElement>('[data-action="review"]')!.disabled).toBe(true);
    expect((document.querySelector('[data-role="reviewProgressBar"]') as HTMLProgressElement).value).toBe(95);
    fixtures.dialogs.at(-1)!.destroy();
    await vi.waitFor(() => expect(stored().imageDecisions[0].status).toBe("reviewed"));
    expect(stored().markdown).toContain("已审阅正文");
    finish(); await vi.waitFor(() => expect(stored().reviewInfo?.summary).toBe("摘要"));
  });

  it("loads old localized thumbnails and large images from SiYuan rather than the source site", async () => {
    const full = "![本地图](assets/local.png)";
    const decisions = imageInventory(full, article.url).map(item => ({ ...item, url: "https://example.com/article/assets/local.png" }));
    fixtures.files.set(DRAFT_STORAGE_NAME, { version: 1, updatedAt: Date.now(), article, url: article.url, markdown: full, reviewedMarkdown: "", imageDecisions: decisions, targetDocumentId: "", perspective: "original", savedDocumentId: "" });
    await launch();
    expect(document.querySelector<HTMLImageElement>('[data-role="imageDecisionList"] img')!.src).toBe(`${window.location.origin}/assets/local.png`);
    document.querySelector<HTMLButtonElement>('[data-role="imageDecisionList"] button')!.click();
    expect(document.querySelector<HTMLImageElement>('[data-role="imageLarge"]')!.src).toBe(`${window.location.origin}/assets/local.png`);
  });

  it("preserves manually edited source metadata and updates the source line once", async () => {
    await launch(); await scrape();
    input("sourceAuthor", "张三"); input("sourcePublished", "2026-10-12"); input("sourceAuthor", "李四");
    fixtures.dialogs.at(-1)!.destroy();
    await vi.waitFor(() => expect(stored().article?.author).toBe("李四"));
    expect(stored().article?.publishedAt).toBe("2026-10-12");
    expect(stored().article?.markdown).toBe(article.markdown);
    expect(stored().markdown.match(/> 来源：/g)).toHaveLength(1);
    expect(stored().markdown).toContain("作者：李四 · 发布时间：2026\\-10\\-12");
    document.querySelector<HTMLButtonElement>("#entry")!.click();
    expect(document.querySelector<HTMLInputElement>('[data-field="sourceAuthor"]')!.value).toBe("李四");
  });

  it("shows waiting, actual image progress and completion within the same AI review", async () => {
    let text: () => void = () => undefined, finish: () => void = () => undefined;
    const inventory = imageInventory("![a](https://example.com/a.png)\n![b](https://example.com/b.png)", article.url);
    const result = { article, markdown: article.markdown, summary: "摘要", imageDecisions: inventory, imagesReviewed: 2, imageWarnings: [], metadataAccepted: [] };
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      await new Promise<void>(resolve => { text = resolve; });
      options?.onTextReviewed?.(result);
      options?.onImageProgress?.({ decisions: [{ ...inventory[0], status: "reviewed" }, inventory[1]], reviewed: 1, warnings: [] });
      await new Promise<void>(resolve => { finish = resolve; });
      return { ...result, imageDecisions: inventory.map(item => ({ ...item, status: "reviewed" })) };
    });
    await launch(); await scrape(); click("review");
    const progress = document.querySelector<HTMLProgressElement>('[data-role="reviewProgressBar"]')!;
    await vi.waitFor(() => expect(document.querySelector('[data-role="reviewProgressLabel"]')!.textContent).toBe("正文审阅"));
    await vi.waitFor(() => expect(reviewArticleDetailed).toHaveBeenCalled());
    expect(progress.hasAttribute("value")).toBe(false);
    text();
    await vi.waitFor(() => expect(progress.value).toBe(68));
    expect(document.querySelector('[data-role="reviewProgressLabel"]')!.textContent).toBe("图片审阅 1/2");
    finish(); await ready(); expect(progress.value).toBe(100);
    expect(document.querySelector('[data-role="reviewProgressLabel"]')!.textContent).toBe("审阅完成");
    expect(document.querySelector('[data-action="reviewImages"]')).toBeNull();
  });

  it("stops the progress bar on failure without showing completion", async () => {
    vi.mocked(reviewArticleDetailed).mockRejectedValueOnce(new Error("model timeout"));
    await launch(); await scrape(); click("review"); await ready();
    expect(document.querySelector('[data-role="reviewProgress"]')!.classList.contains("is-failed")).toBe(true);
    expect(document.querySelector<HTMLProgressElement>('[data-role="reviewProgressBar"]')!.value).toBe(0);
    expect(document.querySelector('[data-role="reviewProgressLabel"]')!.textContent).toBe("审阅失败");
    expect(stored().markdown).toBe(article.markdown);
  });

  it("cleans plugin settings, drafts and cache on uninstall and starts fresh on reinstall", async () => {
    const plugin = await launch(); await scrape(); input("targetDocumentId", "doc");
    vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
      expect(path).toBe("/api/file/removeFile");
      expect(JSON.parse(options.body as string).path).toBe("/data/storage/petal/noosphere-siyuan");
      fixtures.files.clear(); return { ok: true, json: async () => ({ code: 0 }) };
    }));
    localStorage.setItem("another-plugin", "keep");
    plugin.onunload(); await plugin.uninstall();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(fixtures.files.size).toBe(0);
    expect(localStorage.getItem(`noosphere:capture-draft:v1:${window.location.origin}`)).toBeNull();
    expect(localStorage.getItem("another-plugin")).toBe("keep");
    await launch(); expect(document.querySelector<HTMLElement>('[data-view="setup"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLInputElement>('[data-field="modelKey"]')!.value).toBe("");
  });

  it("does not recreate records when a captured article returns after uninstall", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const plugin = await launch(); input("url", article.url);
    vi.stubGlobal("fetch", vi.fn((path: string) => path === "/api/file/removeFile"
      ? Promise.resolve({ ok: true, json: async () => { fixtures.files.clear(); return { code: 0 }; } })
      : new Promise(resolve => { finish = resolve; })));
    click("scrape"); await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    plugin.onunload(); await plugin.uninstall();
    finish({ ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ success: true, data: { markdown: article.markdown } }) } }) });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(fixtures.files.size).toBe(0);
    expect(localStorage.getItem(`noosphere:capture-draft:v1:${window.location.origin}`)).toBeNull();
  });

  it("waits for an existing disk write before deleting plugin storage", async () => {
    const plugin = await launch(); await scrape();
    const original = plugin.saveData.bind(plugin);
    let finish: () => void = () => undefined;
    const events: string[] = [];
    vi.spyOn(plugin, "saveData").mockImplementationOnce(async (name, data) => {
      await new Promise<void>(resolve => { finish = resolve; });
      events.push("write"); return original(name, data);
    });
    input("targetDocumentId", "late-write");
    await vi.waitFor(() => expect(plugin.saveData).toHaveBeenCalled());
    const remove = vi.fn(async () => { events.push("remove"); fixtures.files.clear(); return { ok: true, json: async () => ({ code: 0 }) }; });
    vi.stubGlobal("fetch", remove);
    plugin.onunload(); const cleaned = plugin.uninstall();
    await Promise.resolve(); expect(remove).not.toHaveBeenCalled();
    finish(); await cleaned;
    expect(events).toEqual(["write", "remove"]);
    expect(fixtures.files.size).toBe(0);
  });
});

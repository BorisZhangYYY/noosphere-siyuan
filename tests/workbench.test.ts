// @vitest-environment jsdom
/** 以思源接口替身验证真实工作台关闭、恢复、抓取失败及图片取舍。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ files: new Map<string, unknown>(), dialogs: [] as Array<{ destroy(): void }>, messages: vi.fn(), confirm: vi.fn() }));
vi.mock("siyuan", () => ({
  Plugin: class {
    eventBus = { on: vi.fn(), off: vi.fn() };
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
  openTab: vi.fn(), showMessage: fixtures.messages, confirm: fixtures.confirm,
}));
vi.mock("../src/review/provider", () => ({ listAvailableModels: vi.fn(), reviewArticleDetailed: vi.fn() }));
vi.mock("../src/images/localize", async importOriginal => ({ ...await importOriginal<typeof import("../src/images/localize")>(), localizeMarkdownImages: vi.fn() }));
vi.mock("../src/siyuan/writer", () => ({ validateTargetDocument: vi.fn(), appendArticle: vi.fn() }));
vi.mock("../src/siyuan/tree", () => ({ discoverCategories: vi.fn(), refreshCategoryIndex: vi.fn() }));
vi.mock("../src/siyuan/destination", async importOriginal => ({ ...await importOriginal<typeof import("../src/siyuan/destination")>(), findArticleDocument: vi.fn(), ensureArticleDocument: vi.fn() }));
vi.mock("../src/siyuan/location", async importOriginal => ({ ...await importOriginal<typeof import("../src/siyuan/location")>(), locateDocument: vi.fn() }));
vi.mock("../src/siyuan/index-maintenance", () => ({ CategoryIndexMaintenance: class { onMessage = vi.fn(); schedule = vi.fn(); stop = vi.fn(); } }));
vi.mock("../src/siyuan/category-management", () => ({ ensureClassificationRoot: vi.fn().mockResolvedValue("20260101000000-ooooooo") }));
vi.mock("../src/category-manager", () => ({ openCategoryManager: vi.fn().mockReturnValue(() => undefined) }));
vi.mock("../src/review/classify", () => ({ classifyArticle: vi.fn() }));
// 原生键盘行为在思源现场验收；这里验证工作台与原生编辑器之间的数据和生命周期。
vi.mock("../src/article/editor", async importOriginal => ({
  ...await importOriginal<typeof import("../src/article/editor")>(),
  NativeArticleEditor: class {
    private content = document.createElement("div");
    private state: { markdown: string; nativeMarkdown: string; blockDOM: string };
    private last: string;
    private readOnly = true;
    constructor(_app: unknown, host: HTMLElement, _article: unknown, markdown: string,
      state: { markdown: string; nativeMarkdown: string; blockDOM: string } | undefined,
      private onChange: (state: typeof this.state, title: string) => void) {
      this.state = state || { markdown, nativeMarkdown: markdown, blockDOM: `<div>${markdown}</div>` };
      this.last = markdown; this.content.textContent = markdown; this.content.dataset.role = "nativeContent";
      host.replaceChildren(this.content);
      this.content.addEventListener("input", () => this.flush());
    }
    flush(): void {
      if (this.readOnly || this.last === this.content.textContent) return;
      this.last = this.content.textContent || "";
      this.state = { markdown: this.last, nativeMarkdown: this.last, blockDOM: `<div>${this.last}</div>` };
      this.onChange(this.state, this.last.match(/^#+ (.+)/)?.[1] || "文章标题");
    }
    setReadOnly(value: boolean): void { this.readOnly = value; this.content.setAttribute("contenteditable", String(!value)); }
    setArticle(): void {}
    focus(): void { this.content.focus(); }
    isUploading(): boolean { return false; }
    snapshot(): typeof this.state { return this.state; }
    destroy(): void { this.content.remove(); }
  },
}));

import NoospherePlugin from "../src/index";
import { discoverCategories, refreshCategoryIndex } from "../src/siyuan/tree";
import { articleIdentity, ensureArticleDocument, findArticleDocument } from "../src/siyuan/destination";
import { locateDocument } from "../src/siyuan/location";
import { classifyArticle } from "../src/review/classify";
import { DEFAULT_SETTINGS } from "../src/types";
import { reviewArticleDetailed } from "../src/review/provider";
import { REVIEW_PERSPECTIVES } from "../src/review/perspectives";
import { imageInventory } from "../src/review/images";
import { localizeMarkdownImages } from "../src/images/localize";
import { appendArticle } from "../src/siyuan/writer";
import { type CaptureDraft, DRAFT_STORAGE_NAME } from "../src/article/draft";
import { type CaptureHistory, HISTORY_STORAGE_NAME } from "../src/article/history";
import { openTab } from "siyuan";
import { openCategoryManager } from "../src/category-manager";

const article = { url: "https://example.com/article", title: "文章标题", markdown: "# 文章标题\n\n原文 ![图](https://example.com/photo.png)" };
function input(name: string, value: string): void {
  const field = document.querySelector<HTMLInputElement>(`[data-field="${name}"]`)!;
  field.value = value; field.dispatchEvent(new Event("input"));
}
function stored(): CaptureDraft { return fixtures.files.get(DRAFT_STORAGE_NAME) as CaptureDraft; }
function click(name: string): void { document.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!.click(); }
function confirmCancellation(): void { click("cancelReview"); fixtures.confirm.mock.calls.at(-1)![2](); }
async function ready(): Promise<void> { await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="toggleSettings"]')?.disabled).toBe(false)); }
async function launch(): Promise<NoospherePlugin> {
  const plugin = new NoospherePlugin(); await plugin.onload(); document.querySelector<HTMLButtonElement>("#entry")!.click(); return plugin;
}
async function scrape(): Promise<void> { input("url", article.url); click("scrape"); await ready(); }
function history(): CaptureHistory { return fixtures.files.get(HISTORY_STORAGE_NAME) as CaptureHistory; }
function historyAction(operation: string, index = 0): void {
  document.querySelectorAll<HTMLElement>(".noosphere__history-entry")[index].querySelector<HTMLButtonElement>(`[data-history-action="${operation}"]`)!.click();
}

describe("workbench regression", () => {
  it("keeps assets collapsed with review status visible and shares the save scroller", async () => {
    await launch(); await scrape();
    const assets = document.querySelector<HTMLDetailsElement>('[data-role="imageDecisions"]')!;
    expect(assets.tagName).toBe("DETAILS"); expect(assets.open).toBe(false);
    expect(assets.querySelector("summary")!.textContent).toContain("待审阅");
    expect(assets.closest(".noosphere__inspection-scroll")).toBe(document.querySelector('[aria-label="保存位置"]')!.closest(".noosphere__inspection-scroll"));
    expect(document.querySelector('[data-role="classifyDetails"]')).toBeNull();
    expect(document.querySelector('[data-field="autoCreateIndex"]')!.closest('[data-role="classificationPanel"]')).not.toBeNull();
  });

  beforeEach(() => {
    fixtures.files.clear(); fixtures.dialogs.length = 0; fixtures.messages.mockClear(); document.body.replaceChildren(); localStorage.clear();
    fixtures.files.set("settings.json", { ...DEFAULT_SETTINGS, firecrawlKey: "test", modelKey: "test", modelName: "test", reviewPerspective: "original" });
    vi.mocked(locateDocument).mockResolvedValue({ id: "20260101000000-aaaaaaa", notebook: "20260101000000-0000000", path: "/20260101000000-aaaaaaa.sy", hpath: "/知流", isNotebook: false });
    vi.mocked(discoverCategories).mockResolvedValue([{ id: "20260101000000-bbbbbbb", name: "AI", description: "模型文章", path: "AI", parentId: "20260101000000-aaaaaaa" }]);
    vi.mocked(classifyArticle).mockResolvedValue({ categoryId: "20260101000000-bbbbbbb", confidence: 0.9, reason: "主题匹配" });
    vi.mocked(findArticleDocument).mockResolvedValue(null);
    vi.mocked(ensureArticleDocument).mockResolvedValue({ documentId: "20260101000000-eeeeeee", created: true, parentId: "20260101000000-bbbbbbb" });
    vi.mocked(refreshCategoryIndex).mockResolvedValue(null);
    Object.assign(window, { Lute: { New: () => ({ ProtylePreviewStr: () => "<h1>文章标题</h1><p>原文</p><img src='/photo.png'>" }) } });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ success: true, data: { markdown: article.markdown, metadata: { title: article.title } } }) } }) })));
  });
  afterEach(() => { fixtures.dialogs.at(-1)?.destroy(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("shows read-only builtin guidance for both perspectives and allows custom editing and deletion", async () => {
    await launch(); click("toggleSettings");
    const hint = document.querySelector<HTMLElement>('[data-role="builtinPerspectiveHint"]')!;
    const prompt = document.querySelector<HTMLTextAreaElement>('[data-field="perspectiveEditor"]')!;
    const format = document.querySelector<HTMLTextAreaElement>('[data-field="templateEditor"]')!;
    for (const id of ["original", "novice"] as const) {
      document.querySelector<HTMLButtonElement>(`[data-select-option="reviewPerspective"][data-value="${id}"]`)!.click();
      expect(hint.hidden).toBe(false); expect(hint.textContent).toContain("只读且不可删除");
      expect(prompt.readOnly).toBe(true); expect(format.readOnly).toBe(true);
      expect(prompt.value).toBe(REVIEW_PERSPECTIVES[id].prompt);
      expect(format.value).toBe(REVIEW_PERSPECTIVES[id].template);
      expect(document.querySelector<HTMLElement>('[data-action="deletePerspective"]')!.hidden).toBe(true);
      click("deletePerspective");
      expect(document.querySelector<HTMLInputElement>('[data-field="reviewPerspective"]')!.value).toBe(id);
      click("templateTab"); expect(document.querySelector<HTMLElement>('[data-role="templateBuilder"]')!.hidden).toBe(false);
      click("perspectiveTab"); expect(document.querySelector<HTMLElement>('[data-role="perspectivePrompt"]')!.hidden).toBe(false);
    }
    click("addPerspective");
    expect(hint.hidden).toBe(true); expect(prompt.readOnly).toBe(false); expect(format.readOnly).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-action="deletePerspective"]')!.hidden).toBe(false);
    const id = document.querySelector<HTMLInputElement>('[data-field="reviewPerspective"]')!.value;
    input("perspectiveEditor", "自定义审阅要求"); input("templateEditor", "自定义文章格式");
    click("settings"); await ready();
    expect((fixtures.files.get("settings.json") as typeof DEFAULT_SETTINGS).customPerspectives).toContainEqual(expect.objectContaining({ id, prompt:"自定义审阅要求", template:"自定义文章格式" }));
    click("deletePerspective"); click("deletePerspective");
    expect(document.querySelector(`[data-select-option="reviewPerspective"][data-value="${id}"]`)).toBeNull();
    expect(hint.hidden).toBe(false);
  });

  it("removes the raw AI option and restores legacy draft and history choices without changing their content", async () => {
    fixtures.files.set("settings.json", { ...fixtures.files.get("settings.json") as object, reviewPerspective:"raw" });
    const content = "人工编辑并保留的正文";
    fixtures.files.set(DRAFT_STORAGE_NAME, { version:1, updatedAt:Date.now(), article, url:article.url, markdown:content, reviewedMarkdown:"", bodyEdited:true, imageDecisions:[], targetDocumentId:"", perspective:"raw", savedDocumentId:"" });
    await launch();
    for (const name of ["reviewPerspective", "workPerspective"]) {
      expect(Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-select-option="${name}"]`), option => option.dataset.value)).toEqual(["original", "novice"]);
      expect(document.querySelector<HTMLInputElement>(`[data-field="${name}"]`)!.value).toBe("original");
    }
    expect(document.querySelector('[data-role="nativeContent"]')!.textContent).toBe(content);
    click("showHistory"); historyAction("view");
    expect(document.querySelector<HTMLInputElement>('[data-field="workPerspective"]')!.value).toBe("original");
    expect(document.querySelector('[data-role="nativeContent"]')!.textContent).toBe(content);
    document.querySelector<HTMLButtonElement>('[data-select-option="workPerspective"][data-value="novice"]')!.click();
    expect(document.querySelector('[data-role="nativeContent"]')!.textContent).toBe(content);
    expect(reviewArticleDetailed).not.toHaveBeenCalled(); expect(fixtures.confirm).not.toHaveBeenCalled();
  });

  it("saves from the settings heading, stays in setup and returns without a discard warning", async () => {
    await launch(); click("toggleSettings");
    const setup = document.querySelector<HTMLElement>('[data-view="setup"]')!;
    const state = document.querySelector('[data-role="settingsState"]')!;
    expect(setup.querySelector('.noosphere__page-heading [data-action="settings"]')).not.toBeNull();
    input("modelName", "updated-model");
    await vi.waitFor(() => expect(state.textContent).toBe("未保存"));
    click("settings"); await ready();
    expect(setup.hidden).toBe(false);
    expect(state.textContent).toBe("已保存");
    expect((fixtures.files.get("settings.json") as typeof DEFAULT_SETTINGS).modelName).toBe("updated-model");
    click("toggleSettings");
    expect(fixtures.confirm).not.toHaveBeenCalled();
    expect(setup.hidden).toBe(true);
    click("toggleSettings"); input("modelName", "unsaved-model"); click("toggleSettings");
    expect(fixtures.confirm).toHaveBeenCalledOnce();
    fixtures.confirm.mock.calls[0][2](); click("toggleSettings");
    expect(document.querySelector<HTMLInputElement>('[data-field="modelName"]')!.value).toBe("updated-model");
  });

  it("does not mark browsing blank presets or toggling key visibility as unsaved", async () => {
    await launch(); click("toggleSettings");
    const original = document.querySelector<HTMLInputElement>('[data-field="modelProvider"]')!.value;
    for (const id of ["volcengine", "openai", original]) document.querySelector<HTMLButtonElement>(`[data-provider-id="${id}"]`)!.click();
    document.querySelector<HTMLButtonElement>('[data-reveal="modelKey"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-role="settingsState"]')!.textContent).toBe("已保存"));
    click("toggleSettings");
    expect(fixtures.confirm).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('[data-view="setup"]')!.hidden).toBe(true);
  });

  it("keeps new keys visible while typing and remembers each supplier's eye toggle", async () => {
    await launch(); click("toggleSettings");
    const key = document.querySelector<HTMLInputElement>('[data-field="modelKey"]')!;
    const original = document.querySelector<HTMLInputElement>('[data-field="modelProvider"]')!.value;
    const select = (id: string): void => document.querySelector<HTMLButtonElement>(`[data-provider-id="${id}"]`)!.click();
    expect(key.type).toBe("password");
    expect(document.querySelector<HTMLInputElement>('[data-field="firecrawlKey"]')!.type).toBe("password");
    select("volcengine");
    expect(key.value).toBe(""); expect(key.type).toBe("text");
    input("modelKey", "a"); expect(key.type).toBe("text");
    input("modelKey", "a-new-key"); expect(key.type).toBe("text");
    select(original); expect(key.type).toBe("password");
    select("volcengine"); expect(key.type).toBe("text"); expect(key.value).toBe("a-new-key");
    document.querySelector<HTMLButtonElement>('[data-reveal="modelKey"]')!.click();
    expect(key.type).toBe("password");
    input("modelKey", "a-new-key-2"); expect(key.type).toBe("password");
    select(original); select("volcengine"); expect(key.type).toBe("password");
    input("modelKey", ""); expect(key.type).toBe("text");
    input("modelKey", "replacement"); expect(key.type).toBe("text");
    click("settings"); await ready();
    fixtures.dialogs.at(-1)!.destroy(); await launch(); click("toggleSettings");
    expect(document.querySelector<HTMLInputElement>('[data-field="modelKey"]')!.type).toBe("password");
    expect(document.querySelector<HTMLInputElement>('[data-field="modelKey"]')!.value).toBe("replacement");
  });

  it("saves model configuration before Firecrawl is filled and leaves failed saves dirty", async () => {
    fixtures.files.set("settings.json", { ...DEFAULT_SETTINGS });
    const plugin = await launch();
    const firecrawl = document.querySelector<HTMLInputElement>('[data-field="firecrawlKey"]')!;
    expect(firecrawl.type).toBe("text");
    input("modelKey", "test-new-key"); input("modelName", "test-new-model");
    click("settings"); await ready();
    expect((fixtures.files.get("settings.json") as typeof DEFAULT_SETTINGS).modelKey).toBe("test-new-key");
    expect(document.querySelector('[data-role="settingsState"]')!.textContent).toBe("已保存");
    input("firecrawlKey", "fc-new-key"); expect(firecrawl.type).toBe("text");
    const save = vi.spyOn(plugin, "saveData").mockResolvedValueOnce({ code: -1, msg: "test save failure" });
    click("settings"); await ready();
    expect(fixtures.messages).toHaveBeenCalledWith(expect.stringContaining("保存配置失败"), 7000, "error");
    expect(document.querySelector('[data-role="settingsState"]')!.textContent).toBe("未保存");
    expect((fixtures.files.get("settings.json") as typeof DEFAULT_SETTINGS).firecrawlKey).toBe("");
    save.mockRestore();
  });

  it("creates, renames and deletes custom providers while preserving independent credentials", async () => {
    await launch(); click("toggleSettings");
    const selectProvider = (id: string): void => document.querySelector<HTMLButtonElement>(`[data-provider-id="${id}"]`)!.click();
    expect(document.querySelector('[data-role="providerList"]')!.textContent).toContain("Kimi Code");
    selectProvider("kimi_api");
    expect(document.querySelector<HTMLElement>('[data-action="deleteProvider"]')!.hidden).toBe(true);
    click("deleteProvider");
    expect(document.querySelector<HTMLInputElement>('[data-field="modelProvider"]')!.value).toBe("kimi_api");
    input("modelKey", "builtin-secret");
    click("addProvider"); input("newProviderName", "alpha gateway"); click("createProvider");
    const first = document.querySelector<HTMLInputElement>('[data-field="modelProvider"]')!.value;
    expect(first).toMatch(/^custom_/);
    input("modelKey", "first-secret"); input("modelName", "first-model");
    const vision = document.querySelector<HTMLInputElement>('[data-field="modelVisionCapable"]')!;
    vision.checked = true; vision.dispatchEvent(new Event("change"));
    expect(document.querySelector<HTMLInputElement>('[data-field="imageProvider"]')!.value).toBe(first);
    input("providerName", "renamed gateway");
    document.querySelector('[data-field="providerName"]')!.dispatchEvent(new Event("change"));
    expect(document.querySelector(`[data-provider-id="${first}"] .noosphere__provider-mark`)!.textContent).toBe("RE");
    click("addProvider"); input("newProviderName", "beta"); click("createProvider");
    const second = document.querySelector<HTMLInputElement>('[data-field="modelProvider"]')!.value;
    input("modelKey", "second-secret");
    selectProvider(first);
    expect(document.querySelector<HTMLInputElement>('[data-field="modelKey"]')!.value).toBe("first-secret");
    expect(document.querySelector<HTMLInputElement>('[data-field="modelName"]')!.value).toBe("first-model");
    click("settings"); await ready();
    fixtures.dialogs.at(-1)!.destroy(); await launch(); click("toggleSettings");
    expect(document.querySelector<HTMLInputElement>('[data-field="modelProvider"]')!.value).toBe(first);
    expect(document.querySelector<HTMLInputElement>('[data-field="modelKey"]')!.value).toBe("first-secret");
    expect(document.querySelector('[data-role="providerList"]')!.textContent).toContain("renamed gateway");
    click("deleteProvider"); click("deleteProvider");
    expect(document.querySelector(`[data-provider-id="${first}"]`)).toBeNull();
    expect(document.querySelector<HTMLInputElement>('[data-field="imageProvider"]')!.value).toBe("");
    selectProvider(second);
    expect(document.querySelector<HTMLInputElement>('[data-field="modelKey"]')!.value).toBe("second-secret");
    selectProvider("kimi_api");
    expect(document.querySelector<HTMLInputElement>('[data-field="modelKey"]')!.value).toBe("builtin-secret");
    click("settings"); await ready();
    const saved = fixtures.files.get("settings.json") as import("../src/types").Settings;
    expect(saved.modelProfiles[first as import("../src/review/providers").ProviderId]).toBeUndefined();
    expect(saved.customProviders.map(item => item.id)).toEqual(expect.arrayContaining([second]));
    expect(saved.customProviders.some(item => item.id === first)).toBe(false);
  });

  it("drags suppliers into order and restores it without switching credentials", async () => {
    await launch(); click("toggleSettings");
    const ids = (): string[] => Array.from(document.querySelectorAll<HTMLElement>('[data-provider-id]'), item => item.dataset.providerId!);
    const drag = (source: string, target: string): void => {
      const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
      for (const [id, type] of [[source, "dragstart"], [target, "dragover"], [target, "drop"]]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { dataTransfer: { value: transfer }, clientY: { value: 0 } });
        document.querySelector(`[data-provider-id="${id}"]`)!.dispatchEvent(event);
      }
    };
    const active = document.querySelector<HTMLInputElement>('[data-field="modelProvider"]')!.value;
    const key = document.querySelector<HTMLInputElement>('[data-field="modelKey"]')!.value;
    drag("google", "kimi_api");
    expect(ids()[0]).toBe("google");
    expect(document.querySelector<HTMLInputElement>('[data-field="modelProvider"]')!.value).toBe(active);
    expect(document.querySelector<HTMLInputElement>('[data-field="modelKey"]')!.value).toBe(key);
    click("addProvider"); input("newProviderName", "Move Me"); click("createProvider");
    const custom = document.querySelector<HTMLInputElement>('[data-field="modelProvider"]')!.value;
    drag(custom, "google");
    expect(ids().slice(0, 2)).toEqual([custom, "google"]);
    const order = ids();
    click("settings"); await ready();
    expect((fixtures.files.get("settings.json") as import("../src/types").Settings).providerOrder).toEqual(order);
    fixtures.dialogs.at(-1)!.destroy(); await launch(); click("toggleSettings");
    expect(ids()).toEqual(order);
    // 已有设置的放弃流程也须恢复顺序。
    drag("google", custom);
    click("toggleSettings"); fixtures.confirm.mock.calls.at(-1)![2](); click("toggleSettings");
    expect(ids()).toEqual(order);
    const button = document.querySelector<HTMLButtonElement>(`[data-provider-id="${custom}"]`)!;
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }));
    expect(ids().slice(0, 2)).toEqual(["google", custom]);
    click("deleteProvider"); click("deleteProvider"); click("settings"); await ready();
    expect((fixtures.files.get("settings.json") as import("../src/types").Settings).providerOrder).not.toContain(custom);
  });

  it("discards unsaved provider additions and rejects duplicate names", async () => {
    await launch(); click("toggleSettings");
    click("addProvider"); input("newProviderName", "Kimi API"); click("createProvider");
    expect(document.querySelector('[data-role="providerError"]')!.textContent).toContain("已存在");
    input("newProviderName", "temporary"); click("createProvider");
    const id = document.querySelector<HTMLInputElement>('[data-field="modelProvider"]')!.value;
    click("toggleSettings"); fixtures.confirm.mock.calls.at(-1)![2]();
    click("toggleSettings");
    expect(document.querySelector(`[data-provider-id="${id}"]`)).toBeNull();
  });

  it("keeps language selection only in the workbench and ignores the old global default", async () => {
    fixtures.files.set("settings.json", { ...fixtures.files.get("settings.json") as object, outputLanguage: "en-US" });
    await launch();
    expect(document.querySelector('[data-field="outputLanguage"]')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('[data-field="workOutputLanguage"]')!.value).toBe("follow_ui");
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-select-option="workOutputLanguage"]'), option => option.dataset.value)).toEqual(["follow_ui", "source", "zh-CN", "en-US"]);
    // 空白工作台可以先选再抓取；下一篇文章不会继承上一份语言选择。
    document.querySelector<HTMLButtonElement>('[data-select-option="workOutputLanguage"][data-value="source"]')!.click();
    await scrape();
    expect(stored().outputLanguage).toBe("source");
    document.querySelector<HTMLButtonElement>('[data-select-option="workOutputLanguage"][data-value="zh-CN"]')!.click();
    await vi.waitFor(() => expect(stored().outputLanguage).toBe("zh-CN"));
    await scrape();
    expect(stored().outputLanguage).toBe("follow_ui");
    expect(fixtures.files.get("settings.json")).not.toHaveProperty("outputLanguage");
  });

  it("requires an explicit destination and offers no current-document shortcut", async () => {
    await launch(); await scrape();
    expect(document.querySelector('[data-action="current"]')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('[data-field="targetDocumentId"]')!.value).toBe("");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(true);
  });

  it("keeps destination choices per article and starts a successful new capture with no destination", async () => {
    await launch(); await scrape(); input("targetDocumentId", "20261014100000-aaaaaaa");
    input("url", "https://example.com/second"); click("scrape"); await ready();
    expect(document.querySelector<HTMLInputElement>('[data-field="targetDocumentId"]')!.value).toBe("");
    click("showHistory"); historyAction("view", 1);
    expect(document.querySelector<HTMLInputElement>('[data-field="targetDocumentId"]')!.value).toBe("20261014100000-aaaaaaa");
    click("showHistory"); historyAction("view", 0);
    expect(document.querySelector<HTMLInputElement>('[data-field="targetDocumentId"]')!.value).toBe("");
  });

  it("does not use the legacy global destination for an empty history selection", async () => {
    fixtures.files.set("settings.json", { ...fixtures.files.get("settings.json") as object, targetDocumentId: "20261014100000-aaaaaaa" });
    const draft = { version: 1, updatedAt: Date.now(), article, url: "", markdown: article.markdown, reviewedMarkdown: "", imageDecisions: [], targetDocumentId: "", perspective: "original", savedDocumentId: "" };
    fixtures.files.set(HISTORY_STORAGE_NAME, { version: 1, updatedAt: Date.now(), entries: [{ id: "old", capturedAt: Date.now(), draft }] });
    await launch();
    expect(document.querySelector<HTMLInputElement>('[data-field="targetDocumentId"]')!.value).toBe("");
    click("showHistory"); historyAction("view");
    expect(document.querySelector<HTMLInputElement>('[data-field="targetDocumentId"]')!.value).toBe("");
  });

  it("preserves the actual saved destination across selection changes and blocks saving to it twice", async () => {
    vi.mocked(localizeMarkdownImages).mockResolvedValueOnce({ markdown: article.markdown, localized: 0, warnings: [] });
    vi.mocked(appendArticle).mockResolvedValueOnce("inserted");
    await launch(); await scrape(); input("targetDocumentId", "20261014100000-aaaaaaa"); click("save"); await ready();
    input("targetDocumentId", "20261014100000-aaaaaaa");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(true);
    input("targetDocumentId", "20261014100000-bbbbbbb");
    expect(stored().savedDocumentId).toBe("20261014100000-aaaaaaa");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(false);
    input("targetDocumentId", " 20261014100000-aaaaaaa "); click("save");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(true);
    expect(appendArticle).toHaveBeenCalledOnce();
    input("targetDocumentId", "20261014100000-bbbbbbb"); click("openSaved");
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ doc: { id: "20261014100000-aaaaaaa" } }));
  });

  it("retains the saved-document link after editing and allows saving the changed content", async () => {
    vi.mocked(localizeMarkdownImages).mockResolvedValueOnce({ markdown: article.markdown, localized: 0, warnings: [] });
    vi.mocked(appendArticle).mockResolvedValueOnce("inserted");
    await launch(); await scrape(); input("targetDocumentId", "20261014100000-aaaaaaa"); click("save"); await ready();
    click("editArticle"); document.querySelector('[data-role="nativeContent"]')!.textContent = "# 修改后的标题\n\n修改正文"; click("confirmArticle");
    await vi.waitFor(() => expect(stored().savedContentChanged).toBe(true));
    expect(stored().savedDocumentId).toBe("20261014100000-aaaaaaa");
    expect(document.querySelector<HTMLElement>('[data-role="saved"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(false);
    fixtures.dialogs.at(-1)!.destroy(); await launch();
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(false);
    expect(stored().savedContentChanged).toBe(true);
  });

  it("keeps the capture URL independent and clears it when entering and leaving history", async () => {
    await launch(); await scrape();
    expect(document.querySelector<HTMLInputElement>('[data-field="url"]')!.value).toBe(article.url);
    expect(document.querySelector<HTMLElement>('[data-role="status"]')!.hidden).toBe(true);
    input("url", "https://example.com/new"); click("showHistory"); click("showCapture");
    expect(document.querySelector<HTMLInputElement>('[data-field="url"]')!.value).toBe("");
    expect(document.querySelector('[data-role="nativeContent"]')!.textContent).toContain("原文");
    click("showHistory"); historyAction("view");
    expect(document.querySelector<HTMLInputElement>('[data-field="url"]')!.value).toBe("");
  });

  it("uses the same native content and reading position across read-only and edit mode", async () => {
    await launch(); await scrape();
    const content = document.querySelector('[data-role="nativeContent"]');
    const scroll = document.querySelector<HTMLElement>('[data-role="articleScroll"]')!;
    scroll.scrollTop = 340; click("editArticle");
    expect(document.querySelector('[data-role="nativeContent"]')).toBe(content); expect(scroll.scrollTop).toBe(340);
    click("confirmArticle");
    expect(document.querySelector('[data-role="nativeContent"]')).toBe(content); expect(scroll.scrollTop).toBe(340);
  });

  it("stops following after the body closes while image review is still running", async () => {
    let finish!: () => void, imageProgress!: () => void;
    const result = { article, markdown: "正文已完成", summary: "摘要", imageDecisions: [], imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] };
    Object.assign(window, { Lute: { New: () => ({ ProtylePreviewStr: (_name: string, markdown: string) => `<p>${markdown}</p>` }) } });
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      options?.onTextDelta?.(JSON.stringify({ title: "标题", markdown: result.markdown, summary: result.summary }));
      options?.onTextReviewed?.(result);
      imageProgress = () => options?.onImageProgress?.({ decisions: [], reviewed: 0, warnings: [] });
      await new Promise<void>(resolve => { finish = resolve; }); return result;
    });
    await launch(); await scrape(); click("review");
    await vi.waitFor(() => expect(document.querySelector('[data-role="nativeContent"]')!.textContent).toContain(result.markdown));
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-role="streamNotice"]')!.hidden).toBe(true));
    const scroll = document.querySelector<HTMLElement>('[data-role="articleScroll"]')!;
    expect(document.querySelector<HTMLButtonElement>('[data-action="cancelReview"]')!.hidden).toBe(false);
    expect(scroll.dataset.streamFollowing).toBeUndefined(); scroll.scrollTop = 123; imageProgress();
    expect(scroll.dataset.streamFollowing).toBeUndefined(); expect(scroll.scrollTop).toBe(123);
    finish(); await ready();
  });

  it("confirms native edits as read-only without creating a document and restores them after restarting", async () => {
    const plugin = await launch(); await scrape(); click("editArticle");
    const content = document.querySelector<HTMLElement>('[data-role="nativeContent"]')!;
    expect(content.getAttribute("contenteditable")).toBe("true");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-action="review"]')!.disabled).toBe(true);
    content.textContent = "# 修改后的标题\n\n人工整理的正文";
    content.dispatchEvent(new Event("input")); click("confirmArticle");
    await vi.waitFor(() => expect(stored().bodyEdited).toBe(true));
    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(stored()).toMatchObject({ bodyEdited: true, markdown: content.textContent, article: { title: "修改后的标题", markdown: article.markdown } });
    expect(stored().editorState?.blockDOM).toContain("人工整理");
    expect(appendArticle).not.toHaveBeenCalled();
    plugin.onunload(); await launch();
    expect(document.querySelector('[data-role="nativeContent"]')?.textContent).toContain("人工整理的正文");
    expect(document.querySelector('[data-role="articleMode"]')?.textContent).toBe("只读");
    expect(history().entries[0].draft.editorState).toEqual(stored().editorState);
  });

  it("flushes the final native input on close even before an input event", async () => {
    await launch(); await scrape(); click("editArticle");
    document.querySelector<HTMLElement>('[data-role="nativeContent"]')!.textContent = "# 标题\n\n最后一次输入";
    fixtures.dialogs.at(-1)!.destroy();
    await vi.waitFor(() => expect(stored().markdown).toContain("最后一次输入"));
    document.querySelector<HTMLButtonElement>("#entry")!.click();
    expect(document.querySelector('[data-role="nativeContent"]')?.textContent).toContain("最后一次输入");
  });

  it("reviews the edited content and restores its native formatting on failure", async () => {
    await launch(); await scrape(); click("editArticle");
    const content = document.querySelector<HTMLElement>('[data-role="nativeContent"]')!;
    content.textContent = "# 新标题\n\n人工改写后的正文"; click("confirmArticle");
    await vi.waitFor(() => expect(stored().editorState).toBeDefined());
    const before = structuredClone(stored().editorState);
    vi.mocked(reviewArticleDetailed).mockRejectedValueOnce(new Error("offline"));
    click("review"); await ready();
    expect(reviewArticleDetailed.mock.calls[0][2]).toContain("人工改写后的正文");
    expect(stored().editorState).toEqual(before);
    expect(document.querySelector('[data-role="nativeContent"]')?.textContent).toContain("人工改写后的正文");
  });

  it("keeps native structure when updating source metadata and passes it to the writer", async () => {
    await launch(); await scrape(); click("editArticle");
    document.querySelector<HTMLElement>('[data-role="nativeContent"]')!.textContent = "# 标题\n\n保留格式";
    click("confirmArticle"); await vi.waitFor(() => expect(stored().editorState).toBeDefined());
    const blockDOM = stored().editorState!.blockDOM;
    click("editSource"); input("sourceAuthor", "作者"); click("confirmSource");
    expect(stored().editorState?.blockDOM).toBe(blockDOM);
    vi.mocked(localizeMarkdownImages).mockImplementationOnce(async markdown => ({ markdown, localized: 0, warnings: [] }));
    vi.mocked(appendArticle).mockResolvedValueOnce("inserted");
    input("targetDocumentId", "20261012100000-abcdefg"); click("save"); await ready();
    expect(appendArticle.mock.calls[0][3]).toBe(blockDOM);
    expect(appendArticle.mock.calls[0][1].author).toBe("作者");
  });

  it("shows the historical record time for a legacy article without claiming a capture time", async () => {
    fixtures.files.set(DRAFT_STORAGE_NAME, { version: 1, updatedAt: 1791858929095, article, url: article.url,
      markdown: article.markdown, reviewedMarkdown: "", imageDecisions: [], targetDocumentId: "", perspective: "original", savedDocumentId: "" });
    await launch();
    expect(document.querySelector('[data-role="sourceTimeLabel"]')?.textContent).toBe("记录时间（旧版本）");
    expect(document.querySelector('[data-role="sourceCaptured"]')?.textContent).not.toBe("未记录");
    expect(stored().article?.capturedAt).toBeUndefined();
  });

  it("restores a read-only article and the destination after closing and restarting the plugin", async () => {
    const plugin = await launch(); await scrape();
    expect(document.querySelector<HTMLElement>('[data-role="articleEditor"]')?.hidden).toBe(false);
    expect(document.querySelector('[data-action="edit"], [data-field="markdown"]')).toBeNull();
    input("targetDocumentId", "20261012100000-abcdefg");
    fixtures.dialogs.at(-1)!.destroy();
    document.querySelector<HTMLButtonElement>("#entry")!.click();
    expect(stored().markdown).toBe(article.markdown);
    plugin.onunload(); await Promise.resolve(); await Promise.resolve();
    await launch();
    expect(document.querySelector<HTMLInputElement>('[data-field="targetDocumentId"]')!.value).toBe("20261012100000-abcdefg");
    expect(document.querySelector<HTMLElement>('[data-role="articleEditor"]')!.hidden).toBe(false);
  });

  it("preserves the current article when a changed URL fails to scrape", async () => {
    await launch(); await scrape();
    input("url", "https://example.com/fails");
    expect(stored().markdown).toBe(article.markdown);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); })); click("scrape"); await ready();
    expect((fixtures.files.get(DRAFT_STORAGE_NAME) as CaptureDraft).markdown).toBe(article.markdown);
    expect(document.querySelector<HTMLElement>('[data-role="articleEditor"]')!.hidden).toBe(false);
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
    expect(document.querySelector<HTMLElement>('[data-role="articleEditor"]')!.hidden).toBe(false);
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
    expect(document.querySelector<HTMLInputElement>('[data-field="sourceAuthor"]')!.hidden).toBe(true);
    click("editSource");
    input("sourceAuthor", "张三"); input("sourcePublished", "2026-10-12"); input("sourceAuthor", "李四");
    expect(stored().article?.author).toBeUndefined();
    expect(document.querySelector<HTMLButtonElement>('[data-action="review"]')!.disabled).toBe(true);
    click("confirmSource");
    fixtures.dialogs.at(-1)!.destroy();
    await vi.waitFor(() => expect(stored().article?.author).toBe("李四"));
    expect(stored().article?.publishedAt).toBe("2026-10-12");
    expect(stored().article?.markdown).toBe(article.markdown);
    expect(stored().markdown.match(/> 来源：/g)).toHaveLength(1);
    expect(stored().markdown).toContain("作者：李四\n>\n> 发布时间：2026\\-10\\-12");
    document.querySelector<HTMLButtonElement>("#entry")!.click();
    expect(document.querySelector<HTMLInputElement>('[data-field="sourceAuthor"]')!.value).toBe("李四");
    expect(document.querySelector('[data-role="sourceAuthorText"]')!.textContent).toBe("李四");
    expect(document.querySelector('[data-role="draftStatus"]')).toBeNull();
    expect(document.querySelector('.noosphere__article-toolbar')!.textContent).not.toMatch(/草稿|恢复/);
  });

  it("does not save unconfirmed source edits when the article is closed", async () => {
    await launch(); await scrape(); click("editSource"); input("sourceAuthor", "未确定作者");
    fixtures.dialogs.at(-1)!.destroy(); await launch();
    expect(stored().article?.author).toBeUndefined(); expect(history().entries[0].draft.article?.author).toBeUndefined();
    expect(document.querySelector('[data-role="sourceAuthorText"]')!.textContent).toBe("未填写");
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

  it("reports review failures only through SiYuan messages and hides the failed progress", async () => {
    vi.mocked(reviewArticleDetailed).mockRejectedValueOnce(new Error("model timeout"));
    await launch(); await scrape(); click("review"); await ready();
    expect(document.querySelector<HTMLElement>('[data-role="reviewProgress"]')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-role="status"]')!.hidden).toBe(true);
    expect(document.querySelector('.noosphere')!.textContent).not.toContain("model timeout");
    expect(fixtures.messages).toHaveBeenCalledWith("AI 审阅失败：model timeout", 7000, "error");
    expect(stored().markdown).toBe(article.markdown);
  });

  it("reports image failures once with a short reason instead of a raw URL warning", async () => {
    const decisions = imageInventory(article.markdown, article.url).map(item => ({ ...item, status: "failed" as const, error: "图片下载失败：上游服务返回 HTTP 403：请求被拒绝" }));
    vi.mocked(reviewArticleDetailed).mockResolvedValueOnce({ article, markdown: article.markdown, summary: "摘要", imageDecisions: decisions, imagesReviewed: 0, imageWarnings: ["很长的图片地址和重复详情"], metadataAccepted: [] });
    await launch(); await scrape(); fixtures.messages.mockClear(); click("review"); await ready();
    expect(fixtures.messages.mock.calls.filter(call => call[2] === "error")).toEqual([["图片识别有 1 张未完成，相关图片已保留。图片下载失败：上游服务返回 HTTP 403：请求被拒绝", 7000, "error"]]);
    expect(stored().imageDecisions[0]).toMatchObject({ status: "failed", remove: false });
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
    expect(localStorage.getItem(`noosphere:capture-history:v1:${window.location.origin}`)).toBeNull();
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

  it("lists both captured articles, searches them, and restores each article's content", async () => {
    await launch(); await scrape(); click("editSource"); input("sourceAuthor", "张三"); click("confirmSource");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ success: true, data: { markdown: "第二篇正文", metadata: { title: "另一篇文章" } } }) } }) })));
    input("url", "https://example.com/second"); click("scrape"); await ready(); click("showHistory");
    expect(document.querySelectorAll(".noosphere__history-entry")).toHaveLength(2);
    const search = document.querySelector<HTMLInputElement>('[data-role="historySearch"]')!;
    search.value = "张三"; search.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll(".noosphere__history-entry")).toHaveLength(1);
    historyAction("view");
    expect(document.querySelector<HTMLInputElement>('[data-field="url"]')!.value).toBe("");
    expect(document.querySelector<HTMLInputElement>('[data-field="sourceAuthor"]')!.value).toBe("张三");
    fixtures.dialogs.at(-1)!.destroy(); await vi.waitFor(() => expect(history().entries).toHaveLength(2));
    await launch(); click("showHistory"); expect(document.querySelectorAll(".noosphere__history-entry")).toHaveLength(2);
  });

  it("opens a history article before explicitly reviewing its complete original", async () => {
    fixtures.files.set(DRAFT_STORAGE_NAME, { version: 1, updatedAt: Date.now(), article, url: article.url, markdown: "旧审阅稿", reviewedMarkdown: "旧审阅稿", imageDecisions: [], targetDocumentId: "", perspective: "original", savedDocumentId: "" });
    vi.mocked(reviewArticleDetailed).mockResolvedValueOnce({ article, markdown: "新审阅稿", summary: "摘要", imageDecisions: [], imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] });
    await launch(); click("showHistory");
    expect(document.querySelector('[data-history-action="review"], [data-history-action="import"]')).toBeNull();
    historyAction("view"); expect(reviewArticleDetailed).not.toHaveBeenCalled();
    click("review"); await ready();
    expect(reviewArticleDetailed).toHaveBeenCalledWith(expect.objectContaining({ markdown: article.markdown }), expect.objectContaining({ reviewPerspective: "original" }), article.markdown, expect.any(Object));
    await vi.waitFor(() => expect(history().entries[0].draft.markdown).toBe("新审阅稿"));
    expect(history().entries).toHaveLength(1); expect(history().entries[0].draft.article?.markdown).toBe(article.markdown);
  });

  it("imports a history article from the article page and prevents a second save", async () => {
    fixtures.files.set(DRAFT_STORAGE_NAME, { version: 1, updatedAt: Date.now(), article, url: article.url, markdown: "处理稿", reviewedMarkdown: "处理稿", imageDecisions: [], targetDocumentId: "20261012100000-abcdefg", perspective: "original", savedDocumentId: "" });
    vi.mocked(localizeMarkdownImages).mockResolvedValueOnce({ markdown: "本地化处理稿", localized: 0, warnings: [] });
    vi.mocked(appendArticle).mockResolvedValueOnce("inserted");
    await launch(); click("showHistory"); historyAction("view");
    expect(appendArticle).not.toHaveBeenCalled(); click("save"); await ready();
    expect(appendArticle).toHaveBeenCalledWith("20261012100000-abcdefg", expect.objectContaining({ url: article.url }), "本地化处理稿", undefined);
    await vi.waitFor(() => expect(history().entries[0].draft.savedDocumentId).toBe("20261012100000-abcdefg"));
    click("showHistory"); historyAction("view"); expect(appendArticle).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(true);
  });

  it("opens a history article without starting an import or choosing a document", async () => {
    await launch(); await scrape(); click("showHistory"); historyAction("view");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-role="articleEditor"]')!.hidden).toBe(false);
    expect(appendArticle).not.toHaveBeenCalled();
  });

  it("deletes the active history article and keeps it deleted after restarting", async () => {
    await launch(); await scrape(); click("showHistory");
    historyAction("delete"); expect(fixtures.confirm).toHaveBeenCalled();
    expect(document.querySelectorAll(".noosphere__history-entry")).toHaveLength(1);
    fixtures.confirm.mock.calls.at(-1)![2]();
    await vi.waitFor(() => expect(history().entries).toEqual([]));
    expect(stored().article).toBeNull(); expect(document.querySelectorAll(".noosphere__history-entry")).toHaveLength(0);
    expect(document.querySelector('[data-role="articleMeta"]')!.textContent).toBe("文章正文");
    expect(document.querySelector('[data-role="sourceLink"]')!.hasAttribute("href")).toBe(false);
    fixtures.dialogs.at(-1)!.destroy(); await launch(); click("showHistory");
    expect(document.querySelectorAll(".noosphere__history-entry")).toHaveLength(0);
    expect(appendArticle).not.toHaveBeenCalled();
  });

  it("previews streaming Markdown without persisting unvalidated output on failure", async () => {
    let fail!: (error: Error) => void;
    Object.assign(window, { Lute: { New: () => ({ ProtylePreviewStr: (_name: string, markdown: string) => `<pre>${markdown}</pre>` }) } });
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      options?.onTextDelta?.('{"title":"生成标题","markdown":"正在生成的正文');
      return await new Promise((_resolve, reject) => { fail = reject; });
    });
    await launch(); await scrape(); click("review");
    await vi.waitFor(() => expect(document.querySelector('[data-role="articlePreview"]')!.textContent).toContain("正在生成的正文"));
    expect(document.querySelector<HTMLElement>('[data-role="streamNotice"]')!.hidden).toBe(false);
    expect(document.querySelector('[data-role="reviewProgressDetail"]')!.textContent).toBe("已输出 7 字");
    expect(stored().markdown).toBe(article.markdown); expect(history().entries[0].draft.markdown).toBe(article.markdown);
    fail(new Error("stream interrupted")); await ready();
    expect(document.querySelector('[data-role="nativeContent"]')!.textContent).toContain("原文");
    expect(document.querySelector<HTMLElement>('[data-role="streamNotice"]')!.hidden).toBe(true);
    expect(stored().markdown).toBe(article.markdown);
  });

  it("shows text during generation and completes with the last normal frame without dumping the tail", async () => {
    const body = "一二三四五六七八九十";
    const result = { article, markdown: body, summary: "摘要", imageDecisions: [], imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] };
    let finish!: () => void;
    Object.assign(window, { Lute: { New: () => ({ ProtylePreviewStr: (_name: string, markdown: string) => `<pre>${markdown}</pre>` }) } });
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      options?.onTextDelta?.(JSON.stringify({ title: article.title, markdown: body, summary: "摘要" }));
      await new Promise<void>(resolve => { finish = resolve; }); options?.onTextReviewed?.(result); return result;
    });
    await launch(); await scrape(); vi.useFakeTimers(); click("review"); await vi.advanceTimersByTimeAsync(64);
    const preview = document.querySelector('[data-role="articlePreview"]')!;
    expect(preview.textContent).toContain("一二"); expect(preview.textContent).not.toContain(body);
    expect(document.querySelector('[data-role="reviewState"]')!.textContent).toBe("审阅中");
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(preview.textContent).not.toContain(body);
    await vi.advanceTimersByTimeAsync(64);
    expect(document.querySelector('[data-role="nativeContent"]')!.textContent).toContain(body);
    expect(document.querySelector<HTMLElement>('[data-role="articleEditor"]')!.hidden).toBe(false);
    expect(document.querySelector('[data-role="reviewState"]')!.textContent).toBe("已审阅");
    expect(document.querySelector('[data-role="reviewProgressLabel"]')!.textContent).toBe("审阅完成");
    expect(document.querySelector<HTMLButtonElement>('[data-action="cancelReview"]')!.hidden).toBe(true);
    expect(stored().markdown).toBe(body);
  });

  it("continues after dismissing cancellation and only stops after confirming", async () => {
    let finish!: () => void, signal!: AbortSignal;
    const result = { article, markdown: "最终正文", summary: "摘要", imageDecisions: [], imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] };
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      signal = options!.signal!; await new Promise<void>(resolve => { finish = resolve; }); return result;
    });
    await launch(); await scrape(); click("review"); await vi.waitFor(() => expect(finish).toBeDefined());
    click("cancelReview"); click("cancelReview"); expect(fixtures.confirm).toHaveBeenCalledOnce();
    expect(fixtures.confirm.mock.calls[0][1]).toContain("恢复到本次审阅开始前"); expect(signal.aborted).toBe(false);
    fixtures.confirm.mock.calls[0][3](); expect(signal.aborted).toBe(false);
    confirmCancellation(); await ready(); expect(signal.aborted).toBe(true);
    expect(stored().markdown).toBe(article.markdown); finish();
  });

  it("ignores a late cancellation confirmation after completion and during a different review", async () => {
    let finish!: () => void;
    const result = { article, markdown: "已完成结果", summary: "摘要", imageDecisions: [], imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] };
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return result; });
    await launch(); await scrape(); click("review"); await vi.waitFor(() => expect(finish).toBeDefined());
    click("cancelReview"); const staleConfirm = fixtures.confirm.mock.calls.at(-1)![2];
    finish(); await ready(); staleConfirm(); expect(stored().markdown).toBe(result.markdown);
    let nextFinish!: () => void, nextSignal!: AbortSignal;
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      nextSignal = options!.signal!; await new Promise<void>(resolve => { nextFinish = resolve; }); return result;
    });
    click("review"); await vi.waitFor(() => expect(nextFinish).toBeDefined()); staleConfirm(); expect(nextSignal.aborted).toBe(false);
    nextFinish(); await ready();
  });

  it("keeps a text review running in the background and can reopen its live workbench", async () => {
    let finish!: () => void, signal!: AbortSignal, emit!: (text: string) => void;
    const result = { article, markdown: "后台生成的完整正文", summary: "摘要", imageDecisions: [], imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] };
    Object.assign(window, { Lute: { New: () => ({ ProtylePreviewStr: (_name: string, markdown: string) => `<pre>${markdown}</pre>` }) } });
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      signal = options!.signal!; emit = options!.onTextDelta!;
      emit('{"title":"标题","markdown":"后台'); await new Promise<void>(resolve => { finish = resolve; }); options?.onTextReviewed?.(result); return result;
    });
    await launch(); await scrape(); click("review"); await vi.waitFor(() => expect(finish).toBeDefined());
    fixtures.dialogs.at(-1)!.destroy(); emit('{"title":"标题","markdown":"后台生成的完整正文');
    expect(signal.aborted).toBe(false); document.querySelector<HTMLButtonElement>("#entry")!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-role="articlePreview"]')!.textContent).toContain(result.markdown));
    expect(document.querySelector('[data-role="reviewState"]')!.textContent).toBe("审阅中"); expect(reviewArticleDetailed).toHaveBeenCalledOnce();
    fixtures.dialogs.at(-1)!.destroy(); finish();
    await vi.waitFor(() => expect(stored().markdown).toBe(result.markdown));
    await vi.waitFor(() => expect(fixtures.messages).toHaveBeenCalledWith(expect.stringContaining("审阅完成"), 7000));
    expect(signal.aborted).toBe(false); expect(history().entries[0].draft.markdown).toBe(result.markdown);
    document.querySelector<HTMLButtonElement>("#entry")!.click(); await ready();
    expect(document.querySelector('[data-role="reviewState"]')!.textContent).toBe("已审阅");
  });

  it("surfaces deferred preview errors inside SiYuan and stops the review safely", async () => {
    let finish!: () => void, signal!: AbortSignal;
    const result = { article, markdown: "迟到正文", summary: "摘要", imageDecisions: [], imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] };
    Object.assign(window, { Lute: { New: () => ({ ProtylePreviewStr: (_name: string, markdown: string) => {
      if (markdown.includes("生成错误")) throw new Error("preview failed"); return `<pre>${markdown}</pre>`;
    } }) } });
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      signal = options!.signal!; options?.onTextDelta?.('{"title":"标题","markdown":"生成错误');
      await new Promise<void>(resolve => { finish = resolve; }); return result;
    });
    await launch(); await scrape(); click("review"); await vi.waitFor(() => expect(finish).toBeDefined()); await ready();
    expect(fixtures.messages).toHaveBeenCalledWith("AI 审阅显示失败：preview failed", 7000, "error");
    expect(signal.aborted).toBe(true); expect(stored().markdown).toBe(article.markdown); finish();
  });

  it("remembers output language with each article and passes it to the review", async () => {
    await launch();
    const choose = (language: string): void => document.querySelector<HTMLButtonElement>(`[data-select-option="workOutputLanguage"][data-value="${language}"]`)!.click();
    await scrape(); choose("en-US"); await scrape(); choose("zh-CN");
    click("showHistory"); historyAction("view", 1);
    expect(document.querySelector<HTMLInputElement>('[data-field="workOutputLanguage"]')!.value).toBe("en-US");
    expect(document.querySelector('[data-select-label="workOutputLanguage"]')!.textContent).toBe("英文");
    expect(document.querySelector('[data-field="outputLanguage"]')).toBeNull();
    fixtures.dialogs.at(-1)!.destroy(); await launch();
    vi.mocked(reviewArticleDetailed).mockResolvedValueOnce({ article, markdown: "English result", summary: "summary", imageDecisions: [], imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] });
    click("review"); await ready();
    expect(reviewArticleDetailed).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ outputLanguage: "en-US" }), expect.any(String), expect.any(Object));
    expect(history().entries.find(entry => entry.id === stored().historyId)?.draft.outputLanguage).toBe("en-US");
  });

  it("cancels immediately and ignores the late result of a provider that does not honor abort", async () => {
    let finish!: () => void, signal!: AbortSignal;
    const result = { article, markdown: "迟到的审阅稿", summary: "摘要", imageDecisions: [], imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] };
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      signal = options!.signal!;
      options?.onTextDelta?.('{"title":"流式标题","markdown":"生成中');
      await new Promise<void>(resolve => { finish = resolve; });
      return result;
    });
    await launch(); await scrape(); click("editSource"); input("sourceAuthor", "原作者"); click("confirmSource"); click("review");
    await vi.waitFor(() => expect(reviewArticleDetailed).toHaveBeenCalled());
    expect(document.querySelector<HTMLButtonElement>('[data-action="cancelReview"]')!.disabled).toBe(false);
    confirmCancellation(); await ready();
    expect(signal.aborted).toBe(true); expect(stored().markdown).toContain("原文"); expect(stored().article?.author).toBe("原作者");
    expect(document.querySelector('[data-role="reviewProgressLabel"]')!.textContent).toBe("已取消");
    expect(document.querySelector('[data-role="reviewProgress"]')!.classList.contains("is-failed")).toBe(false);
    finish(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(stored().markdown).not.toContain("迟到的审阅稿"); expect(history().entries[0].draft.markdown).not.toContain("迟到的审阅稿");
    expect(fixtures.messages.mock.calls.some(args => args[2] === "error")).toBe(false);
  });

  it("restores the pre-review article, metadata and image choices when cancelling vision review", async () => {
    let finish!: () => void;
    const result = { article: { ...article, author: "AI 补全" }, markdown: "新处理稿\n" + article.markdown, summary: "摘要", imageDecisions: imageInventory(article.markdown, article.url), imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] };
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      options?.onTextReviewed?.(result);
      options?.onImageProgress?.({ decisions: result.imageDecisions.map(item => ({ ...item, remove: true, status: "reviewed" })), reviewed: 1, warnings: [] });
      await new Promise<void>(resolve => { finish = resolve; }); return result;
    });
    await launch(); await scrape(); click("review");
    await vi.waitFor(() => expect(stored().article?.author).toBe("AI 补全"));
    confirmCancellation(); await ready();
    expect(stored().markdown).toBe(article.markdown); expect(stored().article?.author).toBeUndefined();
    expect(stored().imageDecisions[0].remove).toBe(false); expect(stored().textReviewed).toBe(false);
    finish(); await new Promise(resolve => setTimeout(resolve, 10)); expect(stored().markdown).toBe(article.markdown);
  });

  it("keeps a completed review after reopening without offering undo or persisting a backup", async () => {
    const result = { article: { ...article, author: "AI 作者" }, markdown: "审阅后的正文", summary: "摘要", imageDecisions: [], imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] };
    vi.mocked(reviewArticleDetailed).mockResolvedValueOnce(result);
    await launch(); await scrape(); click("review"); await ready();
    await vi.waitFor(() => expect(stored().markdown).toBe(result.markdown));
    expect(stored()).not.toHaveProperty("reviewBackup");
    expect(document.querySelector<HTMLButtonElement>('[data-action="cancelReview"]')!.hidden).toBe(true);
    fixtures.dialogs.at(-1)!.destroy(); await launch();
    expect(document.querySelector('[data-action="undoReview"]')).toBeNull();
    expect(stored().markdown).toBe(result.markdown); expect(stored().article?.author).toBe("AI 作者"); expect(stored().reviewInfo?.summary).toBe("摘要");
    expect(history().entries[0].draft.markdown).toBe(result.markdown);
    expect(history().entries[0].draft).not.toHaveProperty("reviewBackup");
  });

  it("restores the last completed result when cancelling a new review after streaming starts", async () => {
    Object.assign(window, { Lute: { New: () => ({ ProtylePreviewStr: (_name: string, markdown: string) => `<pre>${markdown}</pre>` }) } });
    const result = { article: { ...article, author: "已确认作者" }, markdown: "上次完成的审阅稿", summary: "上次摘要", imageDecisions: imageInventory(article.markdown, article.url).map(item => ({ ...item, remove: true, recommendedRemove: true })), imagesReviewed: 1, imageWarnings: [], metadataAccepted: [] };
    vi.mocked(reviewArticleDetailed).mockResolvedValueOnce(result);
    await launch(); await scrape(); click("review"); await ready();
    const previous = structuredClone(stored());
    let finish!: () => void;
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_article, _settings, _markdown, options) => {
      options?.onTextDelta?.('{"title":"新标题","markdown":"这次正在生成的正文');
      await new Promise<void>(resolve => { finish = resolve; });
      return { ...result, markdown: "迟到的新审阅稿" };
    });
    click("review");
    await vi.waitFor(() => expect(document.querySelector('[data-role="articlePreview"]')!.textContent).toContain("这次正在生成的正文"));
    confirmCancellation(); await ready();
    for (const key of ["article", "markdown", "reviewedMarkdown", "imageDecisions", "reviewInfo", "textReviewed", "savedDocumentId"] as const) expect(stored()[key]).toEqual(previous[key]);
    expect(history().entries[0].draft.markdown).toBe(result.markdown);
    finish(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(stored().markdown).toBe(result.markdown);
  });

  it("does not call the model after cancellation while saving settings", async () => {
    const plugin = await launch(); await scrape();
    const original = plugin.saveData.bind(plugin); let finish!: () => void;
    vi.spyOn(plugin, "saveData").mockImplementation(async (name, data) => {
      if (name === "settings.json") await new Promise<void>(resolve => { finish = resolve; });
      return original(name, data);
    });
    click("review"); await vi.waitFor(() => expect(finish).toBeDefined());
    confirmCancellation(); await ready(); finish(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(reviewArticleDetailed).not.toHaveBeenCalled(); expect(stored().markdown).toBe(article.markdown);
  });
  /** 自动模式覆盖实际工作台事件，而非只验证底层函数。 */
  async function chooseAuto(): Promise<void> {
    click("showClassification");
    input("rootDocumentId", "20260101000000-aaaaaaa");
    click("saveClassification"); await ready(); click("showCapture");
    document.querySelector<HTMLInputElement>('input[data-field="saveMode"][value="auto"]')!.click();
  }
  function completedReview() {
    return { article, markdown: "已完成的审阅正文", summary: "摘要", imageDecisions: [], imagesReviewed: 0, imageWarnings: [], metadataAccepted: [] };
  }
  function localize(): void {
    vi.mocked(localizeMarkdownImages).mockImplementation(async markdown => ({ markdown, localized: 0, warnings: [] }));
  }
  it("switches back to manual mode with mutually exclusive radio controls", async () => {
    await launch(); await chooseAuto();
    const auto = document.querySelector<HTMLInputElement>('input[data-field="saveMode"][value="auto"]')!;
    document.querySelector<HTMLInputElement>('input[data-field="saveMode"][value="manual"]')!.click();
    expect(auto.checked).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-role="rootSummaryField"]')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-role="targetField"]')!.hidden).toBe(false);
  });
  it("keeps the manual duplicate-save guard after toggling modes", async () => {
    vi.mocked(localizeMarkdownImages).mockImplementationOnce(async markdown => ({ markdown, localized: 0, warnings: [] }));
    await launch(); await scrape(); input("targetDocumentId", "20260101000000-aaaaaaa"); click("save"); await ready();
    await chooseAuto(); document.querySelector<HTMLInputElement>('input[data-field="saveMode"][value="manual"]')!.click();
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(true);
  });
  it("manages root and index settings globally and exposes no root editor in the article", async () => {
    await launch(); await scrape(); await chooseAuto();
    click("showClassification");
    document.querySelector<HTMLInputElement>('[data-field="autoCreateIndex"]')!.click();
    click("saveClassification"); await ready(); click("showCapture");
    expect(document.querySelector('[data-view="setup"] [data-field="rootDocumentId"]')).toBeNull();
    expect(document.querySelector('[data-role="rootSummary"]')!.textContent).toBe("20260101000000-aaaaaaa");
    fixtures.dialogs.at(-1)!.destroy();
    await vi.waitFor(() => expect(stored()).not.toHaveProperty("rootDocumentId"));
    expect(stored()).not.toHaveProperty("autoCreateIndex");
    expect(fixtures.files.get("settings.json")).toMatchObject({ rootDocumentId: "20260101000000-aaaaaaa", autoCreateIndex: true });
    document.querySelector<HTMLButtonElement>("#entry")!.click();
    expect(document.querySelector<HTMLInputElement>('[data-field="rootDocumentId"]')!.closest('[aria-label="分类配置"]')).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('[data-field="autoCreateIndex"]')!.checked).toBe(true);
  });
  function legacyDraft(): CaptureDraft {
    return { version: 1, updatedAt: Date.now(), url: article.url, article, markdown: article.markdown,
      reviewedMarkdown: "", imageDecisions: [], targetDocumentId: "", perspective: "original", savedDocumentId: "",
      rootDocumentId: "20260101000000-ccccccc", autoCreateIndex: false, saveMode: "auto" };
  }
  it("keeps current classification settings when restoring an old draft and opening history", async () => {
    fixtures.files.set("settings.json", { ...DEFAULT_SETTINGS, rootDocumentId: "20260101000000-aaaaaaa", autoCreateIndex: true, firecrawlKey: "test", modelKey: "test", modelName: "test" });
    fixtures.files.set(DRAFT_STORAGE_NAME, legacyDraft());
    fixtures.files.set(HISTORY_STORAGE_NAME, { version: 1, updatedAt: Date.now(), entries: [{ id: "old", capturedAt: Date.now(), draft: legacyDraft() }] });
    await launch(); click("showHistory"); historyAction("view");
    expect(document.querySelector<HTMLInputElement>('[data-field="rootDocumentId"]')!.value).toBe("20260101000000-aaaaaaa");
    expect(document.querySelector<HTMLInputElement>('[data-field="autoCreateIndex"]')!.checked).toBe(true);
    expect(document.querySelector('[data-role="rootSummary"]')!.textContent).toBe("20260101000000-aaaaaaa");
    click("toggleSettings"); click("settings"); await ready();
    expect(fixtures.files.get("settings.json")).toMatchObject({ rootDocumentId: "20260101000000-aaaaaaa", autoCreateIndex: true });
  });
  it("migrates a legacy draft root once without reviving it after explicitly clearing settings", async () => {
    const { classificationSettingsVersion: _version, ...legacySettings } = DEFAULT_SETTINGS;
    fixtures.files.set("settings.json", { ...legacySettings, firecrawlKey: "test" });
    fixtures.files.set(DRAFT_STORAGE_NAME, legacyDraft());
    const plugin = await launch();
    expect(fixtures.files.get("settings.json")).toMatchObject({ rootDocumentId: "20260101000000-ccccccc", classificationSettingsVersion: 1 });
    click("showClassification"); input("rootDocumentId", ""); click("saveClassification"); await ready();
    plugin.onunload(); fixtures.files.set(DRAFT_STORAGE_NAME, legacyDraft());
    await launch();
    expect(document.querySelector<HTMLInputElement>('[data-field="rootDocumentId"]')!.value).toBe("");
    expect(document.querySelector('[data-role="rootSummary"]')!.textContent).toBe("未设置");
  });
  it("prefers an existing global root during the one-time legacy migration", async () => {
    const { classificationSettingsVersion: _version, ...legacySettings } = DEFAULT_SETTINGS;
    fixtures.files.set("settings.json", { ...legacySettings, rootDocumentId: "20260101000000-aaaaaaa", firecrawlKey: "test" });
    fixtures.files.set(DRAFT_STORAGE_NAME, legacyDraft());
    await launch();
    expect(fixtures.files.get("settings.json")).toMatchObject({ rootDocumentId: "20260101000000-aaaaaaa", classificationSettingsVersion: 1 });
  });
  it("keeps classification configuration independent from unsaved model settings and displays the live system prompt", async () => {
    await launch(); await scrape();
    input("modelName", "unsaved-model");
    click("showClassification"); input("rootDocumentId", "20260101000000-aaaaaaa");
    expect(document.querySelector('[data-role="classificationPanel"]')!.textContent).toContain('你只能从给定的分类列表里选择一个 ID');
    expect(document.querySelector('[data-view="setup"] [data-field="rootDocumentId"]')).toBeNull();
    click("saveClassification"); await ready();
    expect(fixtures.files.get("settings.json")).toMatchObject({ rootDocumentId: "20260101000000-aaaaaaa", modelName: "test" });
    expect(document.querySelector<HTMLElement>('[data-role="classificationPanel"]')!.hidden).toBe(false);
    click("showHistory"); expect(document.querySelector<HTMLElement>('[data-role="classificationPanel"]')!.hidden).toBe(true);
  });
  it("opens category management with the saved root and preserves the article", async () => {
    await launch(); await scrape();
    const previous = stored().markdown;
    click("showClassification"); input("rootDocumentId", "20260101000000-aaaaaaa"); click("manageCategories"); await ready();
    expect(openCategoryManager).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rootDocumentId: "20260101000000-aaaaaaa" }), expect.any(Function), expect.any(Function));
    expect(stored().markdown).toBe(previous);
  });
  it("waits for the entire review including image processing before automatic saving", async () => {
    let finish!: () => void; const result = completedReview(); localize();
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(async (_a, _s, _m, options) => {
      options?.onTextReviewed?.(result);
      await new Promise<void>(resolve => { finish = resolve; }); return result;
    });
    await launch(); await scrape(); await chooseAuto(); click("review");
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(ensureArticleDocument).not.toHaveBeenCalled();
    finish(); await ready();
    expect(ensureArticleDocument).toHaveBeenCalledOnce(); expect(appendArticle).not.toHaveBeenCalled();
    expect(stored().savedDocumentId).toBe("20260101000000-eeeeeee");
    expect(stored().autoSave?.sourceKey).toBe(articleIdentity(article));
  });
  it("keeps manual review separate from document saving", async () => {
    vi.mocked(reviewArticleDetailed).mockResolvedValueOnce(completedReview());
    await launch(); await scrape(); click("review"); await ready();
    expect(ensureArticleDocument).not.toHaveBeenCalled(); expect(appendArticle).not.toHaveBeenCalled();
  });
  it("does not save when review fails or is cancelled", async () => {
    vi.mocked(reviewArticleDetailed).mockRejectedValueOnce(new Error("模型失败"));
    await launch(); await scrape(); await chooseAuto(); click("review"); await ready();
    expect(ensureArticleDocument).not.toHaveBeenCalled();
    let finish!: (result: ReturnType<typeof completedReview>) => void;
    vi.mocked(reviewArticleDetailed).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    click("review"); await vi.waitFor(() => expect(finish).toBeDefined()); confirmCancellation(); await ready();
    finish(completedReview()); await new Promise(resolve => setTimeout(resolve, 20));
    expect(ensureArticleDocument).not.toHaveBeenCalled(); expect(stored().markdown).toBe(article.markdown);
  });
  it("requires a valid anchor before sending a review request", async () => {
    vi.mocked(locateDocument).mockRejectedValueOnce(new Error("锚点无效"));
    await launch(); await scrape(); await chooseAuto(); click("review"); await ready();
    expect(reviewArticleDetailed).not.toHaveBeenCalled(); expect(ensureArticleDocument).not.toHaveBeenCalled();
  });
  it("falls back under the configured root when classification fails", async () => {
    localize(); vi.mocked(classifyArticle).mockRejectedValueOnce(new Error("分类超时"));
    await launch(); await scrape(); await chooseAuto(); click("save"); await ready();
    expect(ensureArticleDocument).toHaveBeenCalledWith("20260101000000-aaaaaaa", expect.anything(), expect.anything(), expect.anything());
    expect(appendArticle).not.toHaveBeenCalled(); expect(stored().classification?.reason).toContain("分类超时");
  });
  it("updates the saved source without running classification again", async () => {
    localize(); await launch(); await scrape(); await chooseAuto(); click("save"); await ready();
    vi.mocked(findArticleDocument).mockResolvedValueOnce({ id: "20260101000000-eeeeeee", notebook: "20260101000000-0000000", path: "/20260101000000-aaaaaaa/20260101000000-bbbbbbb/20260101000000-eeeeeee.sy", hpath: "/知流/AI/文章标题", isNotebook: false });
    click("save"); await ready();
    expect(classifyArticle).toHaveBeenCalledOnce();
    expect(ensureArticleDocument).toHaveBeenLastCalledWith("20260101000000-bbbbbbb", expect.anything(), expect.anything(), expect.objectContaining({ existingId: "20260101000000-eeeeeee" }));
  });
  it("retains the completed review and allows retrying a failed automatic save", async () => {
    localize(); vi.mocked(reviewArticleDetailed).mockResolvedValueOnce(completedReview());
    vi.mocked(ensureArticleDocument).mockRejectedValueOnce(new Error("写入失败"));
    await launch(); await scrape(); await chooseAuto(); click("review"); await ready();
    expect(stored().markdown).toBe("已完成的审阅正文"); expect(stored().textReviewed).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(false);
    expect(fixtures.messages).toHaveBeenCalledWith(expect.stringContaining("自动保存失败"), 7000, "error");
  });
  it("keeps successful saves when index refresh fails and retries only the index", async () => {
    localize(); vi.mocked(refreshCategoryIndex).mockRejectedValueOnce(new Error("目录失败"));
    await launch(); await scrape(); await chooseAuto(); click("save"); await ready();
    expect(stored().savedDocumentId).toBe("20260101000000-eeeeeee"); expect(stored().savedContentChanged).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-action="retryIndex"]')!.hidden).toBe(false);
    click("retryIndex"); await ready();
    expect(ensureArticleDocument).toHaveBeenCalledOnce(); expect(stored().indexDocumentId).toBeUndefined();
    expect(document.querySelector<HTMLButtonElement>('[data-action="retryIndex"]')!.hidden).toBe(true);
  });
  it("refreshes managed indexes when a document opens", async () => {
    const plugin = await launch();
    const handler = (plugin as any).eventBus.on.mock.calls.find(([name]: [string]) => name === "loaded-protyle-static")[1];
    handler({ detail: { protyle: { block: { rootID: "20260101000000-bbbbbbb" } } } });
    expect(refreshCategoryIndex).toHaveBeenCalledWith("20260101000000-bbbbbbb");
  });

});

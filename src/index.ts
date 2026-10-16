/** SiYuan frontend plugin entry and capture workflow. */
import { Dialog, Plugin, confirm, openTab, showMessage } from "siyuan";
import { scrapeWithFirecrawl } from "./crawler/firecrawl";
import { listAvailableModels, reviewArticleDetailed } from "./review/provider";
import { applyImageDecisions, imageDecisionStatus, imageInventory, localizeImagePreviews, normalizeImageDecisions, type ImageDecision, type ImageReviewResult } from "./review/images";
import { localizeMarkdownImages, replaceImageAssetRefs } from "./images/localize";
import { migratePerspective, OUTLINE_FORMAT, REVIEW_PERSPECTIVES, validatePerspective } from "./review/perspectives";
import { configuredProfiles, isCustomProvider, moveProvider, orderedProviderIds, presetProfile, providerInfo, providerMark, restoreProviders, validateProviderName, type ModelProfile, type ProviderId } from "./review/providers";
import { appendArticle, validateTargetDocument } from "./siyuan/writer";
import { removePluginStorage } from "./siyuan/cleanup";
import { DEFAULT_SETTINGS, type Article, type ReviewPerspective, type Settings } from "./types";
import { captureContent } from "./ui";
import { CaptureDraftStore, DRAFT_STORAGE_NAME, type CaptureDraft, type ReviewSnapshot, type ArticleEditorState } from "./article/draft";
import { RequestCancelledError, throwIfCancelled } from "./siyuan/api";
import { CaptureHistoryStore, HISTORY_STORAGE_NAME } from "./article/history";
import { partialReviewContent } from "./review/stream";
import { ReviewTextPlayback, reviewPlaybackContent } from "./review/playback";
import { StreamFollowScroll } from "./review/follow";
import { normalizeOutputLanguage } from "./review/language";
import { previewUrl, renderStreamingArticlePreview, reviewPreviewText, type MarkdownRenderer } from "./article/preview";
import { NativeArticleEditor, localizeEditorState, applyEditorImageChoices } from "./article/editor";
import { sourcePlatform } from "./article/source";
import { stripSourceMetadata } from "./article/compose";
import { articleTime, restoreArticleTime } from "./article/time";
import { composeArticle } from "./article/compose";
import "./style.css";

const STORAGE_NAME = "settings.json";

export default class NoospherePlugin extends Plugin {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private captureDialog: Dialog | null = null;
  private captureBusy = false;
  private resumeCaptureDialog: (() => void) | null = null;
  private uninstalled = false;
  private readonly ownedWrites = new Set<Promise<unknown>>();
  private draftStore!: CaptureDraftStore;
  private historyStore!: CaptureHistoryStore;
  private cancelActiveReview: (() => void) | null = null;
  private draggingTopBar = false;
  private readonly onTopBarDragOver = (event: DragEvent): void => {
    if (this.draggingTopBar && event.clientY < 72) event.preventDefault();
  };
  private readonly onTopBarDrop = (event: DragEvent): void => {
    if (!this.draggingTopBar || event.clientY >= 72) return;
    event.preventDefault();
    this.draggingTopBar = false;
    void this.moveTopBar(event.clientX < window.innerWidth / 2 ? "left" : "right");
  };

  /** Surface initialization errors instead of leaving every entry apparently inert. */
  private launchCapture(): void {
    try { this.openCaptureDialog(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("知流采集窗口打开失败", error);
      showMessage(`知流无法打开采集窗口：${message}`, 7000, "error");
    }
  }

  async onload(): Promise<void> {
    // A compact rendition of the existing Noosphere globe mark, without its shadow.
    this.addIcons(`<symbol id="iconNoosphere" viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" fill="#4D98CA"/><path fill="#D7EBC6" d="M14.4 20.5c3.5-6 9.3-10.3 16.1-11.2l2.2 4.1-4.5 2.2-2.4 4.8-5.2 1.7-2.2 4.1-4.7-.8.7-4.9Zm20.8 7.1 5.5-4.2 6.4 1.3 3.7 4.6-1.7 4.4-5.5 1.1-2.6 5-4.6-1.1-2.9-5.8 1.7-5.3ZM20.6 36l5.8-1.4 5 3.6-.7 5.1-4.4 2.3-1.1 7.1A23.2 23.2 0 0 1 12 36.4l3.2 1.8 5.4-2.2Z"/><path fill="none" stroke="#F4FAFF" stroke-linecap="round" stroke-width="1.5" opacity=".65" d="M9.2 32h45.6M32 5.2c8.2 7.1 12.4 16 12.4 26.8S40.2 51.7 32 58.8M32 5.2C23.8 12.3 19.6 21.2 19.6 32S23.8 51.7 32 58.8"/><circle cx="32" cy="32" r="27" fill="none" stroke="#EAF6FF" stroke-width="1.5"/></symbol>`);
    this.addCommand({
      langKey: "openNoosphereCapture",
      langText: "知流：采集网页文章",
      hotkey: "⌥⇧⌘N",
      callback: () => this.launchCapture(),
    });
    const saved = await this.loadData(STORAGE_NAME) as Partial<Settings> | null;
    const customPerspectives = Array.isArray(saved?.customPerspectives)
      ? saved.customPerspectives.filter(item => item && item.id !== "legacy_guidance" && /^[a-z0-9_-]+$/.test(item.id)).map(migratePerspective)
      : [];
    this.settings = { ...DEFAULT_SETTINGS, ...(saved || {}), ...restoreProviders(saved), outputLanguage: "follow_ui", reviewPerspective: saved?.reviewPerspective && saved.reviewPerspective !== "raw" && saved.reviewPerspective !== "legacy_guidance" ? saved.reviewPerspective : "original", customPerspectives };
    let recovery: Storage | undefined;
    try { recovery = window.localStorage; } catch { /* 浏览器不允许本地缓存时仍保存到思源。 */ }
    const workspaceId = (window as unknown as { siyuan?: { config?: { system?: { workspaceDir?: string } } } }).siyuan?.config?.system?.workspaceDir || window.location.origin;
    this.draftStore = new CaptureDraftStore(
      () => this.loadData(DRAFT_STORAGE_NAME),
      async draft => {
        const result = await this.saveOwnedData(DRAFT_STORAGE_NAME, draft) as { code?: number; msg?: string };
        if (result?.code !== 0) throw new Error(result?.msg || "草稿保存失败");
      },
      error => showMessage(`草稿未能保存到思源，请稍后重试：${String(error)}`, 7000, "error"),
      recovery,
      workspaceId,
    );
    await this.draftStore.load();
    this.historyStore = new CaptureHistoryStore(
      () => this.loadData(HISTORY_STORAGE_NAME),
      async history => {
        const result = await this.saveOwnedData(HISTORY_STORAGE_NAME, history) as { code?: number; msg?: string };
        if (result?.code !== 0) throw new Error(result?.msg || "历史记录保存失败");
      },
      error => showMessage(`历史记录保存失败：${String(error)}`, 7000, "error"), recovery, workspaceId,
    );
    await this.historyStore.load();
    const currentDraft = this.draftStore.current;
    const historyId = this.historyStore.migrate(currentDraft);
    if (currentDraft && historyId) {
      const entry = this.historyStore.entries.find(item => item.id === historyId);
      this.draftStore.update({ ...currentDraft, historyId,
        article: currentDraft.article ? restoreArticleTime(currentDraft.article, entry?.capturedAt) : null });
    }
    document.querySelectorAll('[data-id="noosphere-capture-left"], [data-id="noosphere-capture-right"]').forEach(entry => entry.remove());
    this.registerTopBar();
    document.addEventListener("dragover", this.onTopBarDragOver);
    document.addEventListener("drop", this.onTopBarDrop);
  }

  private registerTopBar(): void {
    const topBar = this.addTopBar({
      id: "noosphere-capture",
      icon: "iconNoosphere",
      title: "知流",
      position: this.settings.topBarPosition,
      callback: () => this.launchCapture(),
      contextMenu: (menu) => {
        for (const side of ["left", "right"] as const) {
          menu.addItem({
            label: side === "left" ? "移至顶部左侧" : "移至顶部右侧",
            checked: this.settings.topBarPosition === side,
            click: () => { void this.moveTopBar(side); },
          });
        }
      },
    });
    topBar?.classList.add("noosphere-topbar-icon");
    if (topBar && !topBar.dataset.noosphereDragBound) {
      topBar.draggable = true;
      topBar.addEventListener("dragstart", (event) => {
        this.draggingTopBar = true;
        event.dataTransfer?.setData("text/plain", "noosphere-capture");
      });
      topBar.addEventListener("dragend", () => { this.draggingTopBar = false; });
      topBar.dataset.noosphereDragBound = "true";
    }
  }

  private async moveTopBar(position: Settings["topBarPosition"]): Promise<void> {
    if (this.settings.topBarPosition === position) return;
    this.settings.topBarPosition = position;
    this.registerTopBar();
    try { await this.saveOwnedData(STORAGE_NAME, this.settings); }
    catch (error) { showMessage(`知流位置保存失败：${String(error)}`, 5000, "error"); }
  }

  onunload(): void {
    this.cancelActiveReview?.();
    this.captureDialog?.destroy();
    this.resumeCaptureDialog = null;
    document.removeEventListener("dragover", this.onTopBarDragOver);
    document.removeEventListener("drop", this.onTopBarDrop);
  }

  /** 将插件文件写入纳入卸载等待，删除后不会被旧请求再次创建。 */
  private async saveOwnedData(name: string, value: unknown): Promise<unknown> {
    if (this.uninstalled) throw new Error("知流已卸载");
    const writing = this.saveData(name, value);
    this.ownedWrites.add(writing);
    try { return await writing; } finally { this.ownedWrites.delete(writing); }
  }

  /** 思源仅在真正卸载时调用此钩子；普通关闭、禁用和升级继续保留草稿。 */
  async uninstall(): Promise<void> {
    this.uninstalled = true;
    this.cancelActiveReview?.();
    let cacheError: unknown;
    try { this.draftStore?.dispose(); } catch (error) { cacheError = error; }
    try { this.historyStore?.dispose(); } catch (error) { cacheError ||= error; }
    this.captureDialog?.destroy();
    this.settings = { ...DEFAULT_SETTINGS, modelProfiles: {}, customPerspectives: [] };
    this.data = {};
    await Promise.allSettled(Array.from(this.ownedWrites));
    this.captureBusy = false;
    this.resumeCaptureDialog = null;
    this.data = {};
    this.settings = { ...DEFAULT_SETTINGS, modelProfiles: {}, customPerspectives: [] };
    try {
      await removePluginStorage();
      if (cacheError) throw cacheError;
    }
    catch (error) {
      showMessage(`知流卸载后的数据清理未完成：${error instanceof Error ? error.message : String(error)}`, 10000, "error");
      throw error;
    }
  }

  /** Open onboarding for a new workspace, otherwise show the capture workbench. */
  private openCaptureDialog(): void {
    if (this.uninstalled) return;
    if (this.captureDialog) {
      this.captureDialog.element.querySelector<HTMLInputElement>('[data-field="url"]')?.focus();
      return;
    }
    if (this.captureBusy && this.resumeCaptureDialog) { this.resumeCaptureDialog(); return; }
    const draft = this.draftStore.current;
    let article: Article | null = draft?.article || null;
    let busy = false;
    let savingSettings = false;
    let reviewing = false;
    let cancelConfirmationOpen = false;
    let savedDocumentId = draft?.savedDocumentId || "";
    let savedContentChanged = draft?.savedContentChanged || false;
    let reviewedMarkdown = draft?.reviewedMarkdown || "";
    let imageDecisions: ImageDecision[] = draft?.imageDecisions.map(item => ({ ...item })) || [];
    if (article) imageDecisions = normalizeImageDecisions(imageDecisions, article.url);
    let reviewInfo: CaptureDraft["reviewInfo"] = draft?.reviewInfo;
    let textReviewed = draft?.textReviewed ?? (!!reviewInfo || !!reviewedMarkdown);
    let sourceEditing = false;
    let bodyEditing = false;
    let bodyEdited = draft?.bodyEdited || false;
    let editorState: ArticleEditorState | undefined = draft?.editorState;
    let nativeEditor: NativeArticleEditor | undefined;
    let nativeContentKey = "";
    let finishArticleEditing: () => void = () => undefined;
    let disposeArticleEditor: () => void = () => undefined;
    let reviewController: AbortController | undefined;
    let historyId = draft?.historyId;
    let streamingMarkdown = "";
    let previewMarkdown = "";
    let followStream = true;
    let textFollowComplete = false;
    let streamBodyValidated = false;
    let playback: ReviewTextPlayback | undefined;
    let streamFollower: StreamFollowScroll | undefined;
    let streamPreviewTimer: ReturnType<typeof setTimeout> | undefined;
    let dialogClosed = false;
    let streamTitle = article?.title || "";
    let imageStage = "";
    let historyVisible = false;
    let selectedImage: ImageDecision | undefined;
    let persistDraft: (delayMs?: number) => void = () => undefined;
    const createDialog = (): Dialog => new Dialog({
      title: "知流",
      width: `${Math.min(1360, window.innerWidth - 32)}px`,
      content: captureContent(),
      destroyCallback: () => {
        finishArticleEditing(); disposeArticleEditor();
        dialogClosed = true; playback?.setPaused(true);
        streamFollower?.setEnabled(false);
        if (!busy) streamFollower?.stop();
        persistDraft();
        void this.draftStore.flush().catch(error => showMessage(`草稿保存失败：${String(error)}`, 7000, "error"));
        void this.historyStore.flush().catch(error => showMessage(`历史记录保存失败：${String(error)}`, 7000, "error"));
        this.captureDialog = null;
        if (!busy) this.resumeCaptureDialog = null;
      },
    });
    let dialog = createDialog();
    this.captureDialog = dialog;
    let dialogHeader = dialog.element.querySelector<HTMLElement>(".b3-dialog__header");
    if (!dialogHeader) throw new Error("知流标题栏没有正确加载");
    dialogHeader.classList.add("noosphere-dialog-header");
    dialogHeader.setAttribute("aria-label", "知流");
    dialogHeader.innerHTML = `<span class="noosphere-dialog-brand"><svg viewBox="0 0 64 64" aria-hidden="true"><use href="#iconNoosphere"/></svg><span>知流</span></span><button class="noosphere-dialog-settings" data-action="toggleSettings" type="button"><svg aria-hidden="true"><use href="#iconSettings"/></svg><span data-role="settingsActionLabel">设置</span></button>`;
    // Keep clicks on the settings action from starting the dialog's title-bar drag.
    const settingsAction = dialogHeader.querySelector<HTMLButtonElement>('[data-action="toggleSettings"]')!;
    settingsAction.addEventListener("pointerdown", event => event.stopPropagation());
    settingsAction.addEventListener("mousedown", event => event.stopPropagation());
    const root = dialog.element.querySelector<HTMLElement>(".noosphere");
    if (!root) throw new Error("知流页面没有正确加载");
    const field = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(name: string): T => {
      const element = root.querySelector<T>(`[data-field="${name}"]`);
      if (!element) throw new Error(`缺少输入项：${name}`);
      return element;
    };
    const action = (name: string): HTMLButtonElement => {
      const element = dialog.element.querySelector<HTMLButtonElement>(`[data-action="${name}"]`);
      if (!element) throw new Error(`缺少操作：${name}`);
      return element;
    };
    const setup = root.querySelector<HTMLElement>('[data-view="setup"]')!;
    const workbench = root.querySelector<HTMLElement>('[data-view="workbench"]')!;
    const status = root.querySelector<HTMLElement>('[data-role="status"]')!;
    const statusText = root.querySelector<HTMLElement>('[data-role="statusText"]')!;
    const meta = root.querySelector<HTMLElement>('[data-role="articleMeta"]')!;
    const empty = root.querySelector<HTMLElement>('[data-role="empty"]')!;
    const saved = root.querySelector<HTMLElement>('[data-role="saved"]')!;
    // 正文只读；保留内部 Markdown 供审阅和写入，不暴露源码编辑框。
    const markdown = { value: draft?.markdown || "" };
    const articlePreview = root.querySelector<HTMLElement>('[data-role="articlePreview"]')!;
    const luteFactory = (window as unknown as { Lute?: { New(): MarkdownRenderer } }).Lute;
    let renderer = luteFactory?.New();
    if (!renderer) showMessage("思源阅读组件未加载，请重启思源后重试。", 7000, "error");
    const imageDecisionList = root.querySelector<HTMLElement>('[data-role="imageDecisionList"]')!;
    const imageDecisionCount = root.querySelector<HTMLElement>('[data-role="imageDecisionCount"]')!;
    const inputUrl = field<HTMLInputElement>("url");
    const target = field<HTMLInputElement>("targetDocumentId");
    const sourceAuthor = field<HTMLInputElement>("sourceAuthor");
    const sourcePublished = field<HTMLInputElement>("sourcePublished");
    const setupPerspective = field<HTMLInputElement>("reviewPerspective");
    const workPerspective = field<HTMLInputElement>("workPerspective");
    const workOutputLanguage = field<HTMLInputElement>("workOutputLanguage");
    const modelProvider = field<HTMLInputElement>("modelProvider");
    const imageProvider = field<HTMLInputElement>("imageProvider");
    const modelFormat = field<HTMLInputElement>("modelFormat");
    const modelVisionCapable = field<HTMLInputElement>("modelVisionCapable");

    // 已保存的密钥使用固定圆点；空白输入默认明文，输入时不改变显隐模式。
    const secretVisibility = new Map<ProviderId, boolean>();
    const syncSecretPreview = (input: HTMLInputElement): void => {
      const wrapper = input.closest<HTMLElement>(".noosphere__secret")!;
      wrapper.classList.toggle("has-value", Boolean(input.value));
    };
    const setSecretVisibility = (input: HTMLInputElement, visible: boolean): void => {
      input.type = visible ? "text" : "password";
      input.closest(".noosphere__secret")!.classList.toggle("is-revealed", visible);
      const button = root.querySelector<HTMLButtonElement>(`[data-reveal="${input.dataset.field}"]`)!;
      const label = `${visible ? "隐藏" : "显示"}密钥`;
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.setAttribute("aria-pressed", String(visible));
      if (input.dataset.field === "modelKey") secretVisibility.set(modelProvider.value as ProviderId, visible);
      syncSecretPreview(input);
    };
    target.value = draft?.targetDocumentId || "";
    inputUrl.value = draft?.url || "";
    markdown.value = draft?.markdown || "";
    for (const name of ["firecrawlKey", "modelBaseUrl", "modelKey", "modelName"] as const) {
      field(name).value = this.settings[name];
    }
    modelFormat.value = this.settings.modelFormat;
    modelVisionCapable.checked = this.settings.modelVisionCapable;
    modelProvider.value = this.settings.activeProvider;
    root.querySelectorAll<HTMLInputElement>(".noosphere__secret input").forEach(input => {
      setSecretVisibility(input, !input.value);
      input.addEventListener("input", () => {
        if (!input.value) setSecretVisibility(input, true);
        else syncSecretPreview(input);
      });
    });
    imageProvider.value = this.settings.imageProvider;
    workOutputLanguage.value = normalizeOutputLanguage(draft?.outputLanguage);
    let customProviders = this.settings.customProviders.map(item => ({ ...item }));
    let providerOrder = [...this.settings.providerOrder];
    let customPerspectives: ReviewPerspective[] = this.settings.customPerspectives.map(item => ({ ...item }));
    /** 旧版“原文”和已删除视角回退到 AI 视角，正文及人工修改保持原样。 */
    const availablePerspective = (id: string | undefined): string => id && (REVIEW_PERSPECTIVES[id as keyof typeof REVIEW_PERSPECTIVES] || customPerspectives.some(item => item.id === id)) ? id : "original";
    setupPerspective.value = availablePerspective(this.settings.reviewPerspective);
    workPerspective.value = availablePerspective(draft?.perspective || this.settings.reviewPerspective);
    const modelProfiles: Settings["modelProfiles"] = { ...this.settings.modelProfiles };
    let perspectiveTab: "prompt" | "template" = "prompt";

    const role = (name: string): HTMLElement => root.querySelector<HTMLElement>(`[data-role="${name}"]`)!;
    /** 已保存位置描述实际导入记录，正文改动或另选位置时仍可打开原文档。 */
    const renderSavedLocation = (): void => {
      saved.hidden = !article || !savedDocumentId;
      saved.querySelector("span")!.textContent = "已保存";
    };
    /** 来源与正文各自排版，正文滚动不会带走右侧保存按钮。 */
    const renderArticle = (): void => {
      if (dialogClosed) return;
      const hasArticle = !!article;
      empty.hidden = hasArticle;
      articlePreview.hidden = !hasArticle;
      if (article) {
        meta.textContent = article.title;
        meta.title = article.title;
        role("sourcePlatform").textContent = sourcePlatform(article.url);
        role("sourceSummary").textContent = role("sourcePlatform").textContent;
        role("sourceAuthorText").textContent = article.author || "未填写";
        role("sourcePublishedText").textContent = article.publishedAt || "未填写";
        role("sourceAuthorText").title = article.author || "未填写";
        role("sourcePublishedText").title = article.publishedAt || "未填写";
        if (!sourceEditing) { sourceAuthor.value = article.author || ""; sourcePublished.value = article.publishedAt || ""; }
        const time = articleTime(article);
        role("sourceTimeLabel").textContent = time.label;
        role("sourceCaptured").textContent = time.value;
        const link = role("sourceLink") as HTMLAnchorElement;
        const url = previewUrl(article.url, article.url);
        link.hidden = !url;
        if (url) link.href = url;
        if (renderer && playback?.active && (!streamBodyValidated || playback.pending)) {
          role("articleEditor").hidden = true;
          renderStreamingArticlePreview(articlePreview, article, streamTitle, previewMarkdown, renderer, playback.count);
        }
        else {
          articlePreview.hidden = true;
          role("articleEditor").hidden = false;
          const contentKey = editorState?.markdown === markdown.value ? editorState.blockDOM : stripSourceMetadata(composeArticle(article, markdown.value));
          if (!nativeEditor || (!bodyEditing && nativeContentKey !== contentKey)) {
            disposeArticleEditor();
            nativeEditor = new NativeArticleEditor(this.app, role("articleEditor"), article, markdown.value, editorState, acceptArticleEdit);
            nativeContentKey = contentKey;
            renderer = nativeEditor.markdownRenderer?.() || renderer;
          }
          nativeEditor.setArticle(article);
          nativeEditor.setReadOnly(!bodyEditing);
        }

      } else {
        // 删除当前历史文章后同时清空来源，避免仍展示已删除文章的链接。
        sourceEditing = false; bodyEditing = false; editorState = undefined; bodyEdited = false;
        disposeArticleEditor(); role("articleEditor").hidden = true;
        meta.textContent = "文章正文"; meta.removeAttribute("title");
        role("sourcePlatform").textContent = "—"; role("sourceSummary").textContent = "—";
        sourceAuthor.value = ""; sourcePublished.value = ""; role("sourceCaptured").textContent = "—";
        role("sourceAuthorText").textContent = "—"; role("sourcePublishedText").textContent = "—";
        role("sourceLink").hidden = true; role("sourceLink").removeAttribute("href");
        articlePreview.replaceChildren();
      }
      role("reviewState").textContent = reviewing ? "审阅中" : textReviewed ? "已审阅" : "待审阅";
      role("reviewInfo").textContent = reviewInfo ? `${reviewInfo.model} · ${new Date(reviewInfo.completedAt).toLocaleString()}` : textReviewed ? "" : "选择视角，整理当前文章。";
      role("reviewInfo").hidden = !role("reviewInfo").textContent;
    };
    const snapshotDraft = (): CaptureDraft => ({ version: 1, updatedAt: Date.now(), url: inputUrl.value, article, markdown: markdown.value,
      reviewedMarkdown, imageDecisions, targetDocumentId: target.value, perspective: workPerspective.value, outputLanguage: normalizeOutputLanguage(workOutputLanguage.value), savedDocumentId, savedContentChanged, reviewInfo, textReviewed, historyId, bodyEdited,
      editorState: editorState?.markdown === markdown.value ? editorState : undefined });
    /** 旧版本对重复图片的判断统一后，同步显示正文，保留人工编辑的原生格式。 */
    const repairImageChoices = (previous: ImageDecision[]): boolean => {
      if (!imageDecisions.some(item => item.remove && !previous.find(old => old.full === item.full)?.remove)) return false;
      markdown.value = applyImageDecisions(reviewedMarkdown || markdown.value, imageDecisions);
      if (editorState) editorState = applyEditorImageChoices(editorState, markdown.value, imageDecisions);
      savedContentChanged = !!savedDocumentId; renderSavedLocation();
      return true;
    };
    persistDraft = (delayMs = 250): void => {
      const snapshot = snapshotDraft();
      this.draftStore.update(snapshot, delayMs);
      if (article && historyId) this.historyStore.update(historyId, snapshot, delayMs);
      role("historyCount").textContent = String(this.historyStore.entries.length);
      if (historyVisible) renderHistory();
    };
    const markUnsaved = (): void => {
      savedContentChanged = !!savedDocumentId;
      renderSavedLocation();
    };
    /** 选择保存位置不改变既有导入记录；同一内容已经保存到当前目标时禁止重复追加。 */
    const savedToTarget = (): boolean => !!savedDocumentId && !savedContentChanged && savedDocumentId === target.value.trim();

    /** 原生正文变更立即进入恢复缓存；来源和抓取原文独立保留。 */
    const acceptArticleEdit = (state: ArticleEditorState, title: string): void => {
      if (!article || busy || this.uninstalled) return;
      editorState = state; nativeContentKey = state.blockDOM;
      markdown.value = state.markdown;
      article = { ...article, title: title || article.title };
      bodyEdited = true;
      reviewedMarkdown = state.markdown;
      const previous = imageDecisions;
      imageDecisions = imageInventory(state.markdown, article.url).map(item => {
        const known = previous.find(old => old.url === item.url || old.previewUrl === item.url);
        return known ? { ...known, ...item, description: known.description, recommendedRemove: known.recommendedRemove,
          remove: known.remove, status: known.status, error: known.error } : item;
      });
      markUnsaved(); persistDraft(); renderImageDecisions(); updateActions();
      meta.textContent = article.title; meta.title = article.title;
    };
    disposeArticleEditor = (): void => {
      nativeEditor?.destroy(); nativeEditor = undefined; nativeContentKey = "";
    };
    finishArticleEditing = (): void => {
      if (!bodyEditing || !nativeEditor) return;
      const top = role("articleScroll").scrollTop;
      nativeEditor.flush();
      bodyEditing = false; nativeEditor.setReadOnly(true);
      persistDraft(); renderArticle(); updateActions();
      role("articleScroll").scrollTop = top;
      void Promise.all([this.draftStore.flush(), this.historyStore.flush()])
        .catch(error => showMessage(`文章修改保存失败：${String(error)}`, 7000, "error"));
    };
    action("editArticle").addEventListener("click", () => {
      if (!article || busy || bodyEditing || sourceEditing) return;
      try {
        const top = role("articleScroll").scrollTop;
        bodyEditing = true; renderArticle(); updateActions(); nativeEditor?.focus();
        role("articleScroll").scrollTop = top;
      } catch (error) {
        bodyEditing = false; disposeArticleEditor(); renderArticle(); updateActions();
        showMessage(`正文编辑器无法加载：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
      }
    });
    action("confirmArticle").addEventListener("click", () => {
      if (nativeEditor?.isUploading()) { showMessage("图片正在上传，请完成后再确定。", 5000, "info"); return; }
      finishArticleEditing();
    });

    const showView = (view: "setup" | "workbench"): void => {
      setup.hidden = view !== "setup";
      workbench.hidden = view !== "workbench";
      const headerAction = action("toggleSettings");
      const headerActionLabel = view === "setup" ? "返回工作台" : "设置";
      headerAction.querySelector<HTMLElement>('[data-role="settingsActionLabel"]')!.textContent = headerActionLabel;
      headerAction.querySelector("use")!.setAttribute("href", view === "setup" ? "#iconBack" : "#iconSettings");
      headerAction.setAttribute("aria-label", headerActionLabel);
      if (view === "workbench") inputUrl.focus();
    };
    const setStatus = (message: string, tone: "info" | "success" = "info"): void => {
      status.hidden = false;
      status.dataset.tone = tone;
      statusText.textContent = message;
    };
    const progressPanel = role("reviewProgress");
    const progressBar = role("reviewProgressBar") as HTMLProgressElement;
    /** 使用网页端的阶段标签和原生进度条；等待正文响应时显示不确定进度。 */
    const setReviewProgress = (label: string, value: number | null, detail: string): void => {
      progressPanel.hidden = false;
      progressPanel.classList.remove("is-failed");
      role("reviewProgressLabel").textContent = label;
      role("reviewProgressDetail").textContent = detail;
      progressBar.setAttribute("aria-valuetext", `${label}，${detail}`);
      if (value === null) progressBar.removeAttribute("value");
      else progressBar.value = value;
    };
    const updateActions = (): void => {
      role("articleMode").textContent = bodyEditing ? "编辑中" : "只读";
      action("editArticle").hidden = bodyEditing; action("confirmArticle").hidden = !bodyEditing;
      action("editArticle").disabled = busy || bodyEditing || sourceEditing || !article;
      action("confirmArticle").disabled = busy;
      const activeCustom = customPerspectives.find(item => item.id === setupPerspective.value);
      action("scrape").disabled = busy || bodyEditing || sourceEditing || !inputUrl.value.trim();
      action("review").disabled = busy || bodyEditing || sourceEditing || !article || !markdown.value.trim();
      action("review").textContent = reviewing ? "审阅中…" : "AI 审阅";
      action("cancelReview").hidden = !reviewing;
      action("cancelReview").disabled = !reviewing || !!reviewController?.signal.aborted;
      action("save").disabled = busy || bodyEditing || sourceEditing || !article || !markdown.value.trim() || !target.value.trim() || savedToTarget();
      action("toggleImage").disabled = busy || bodyEditing || savedToTarget();
      for (const name of ["settings", "toggleSettings", "openSaved", "listModels", "addPerspective", "deletePerspective", "perspectiveTab", "templateTab", "addProvider", "createProvider", "cancelProvider", "deleteProvider"] as const) action(name).disabled = busy;
      for (const name of ["showCapture", "showHistory"]) action(name).disabled = busy;
      role("historyList").querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = busy; });
      role("providerList").querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = busy; });
      root.querySelectorAll<HTMLButtonElement>("[data-select-trigger], [data-select-option], [data-reveal]").forEach(button => { button.disabled = busy; });
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea").forEach(input => { input.disabled = busy || (savedToTarget() && !!input.closest(".noosphere__asset")); });
      for (const sourceField of [sourceAuthor, sourcePublished]) { sourceField.disabled = busy || !article || !sourceEditing; sourceField.hidden = !sourceEditing; }
      role("sourceAuthorText").hidden = sourceEditing; role("sourcePublishedText").hidden = sourceEditing;
      action("editSource").hidden = sourceEditing; action("confirmSource").hidden = !sourceEditing;
      action("editSource").disabled = busy || bodyEditing || !article; action("confirmSource").disabled = busy || !article;
      field<HTMLTextAreaElement>("perspectiveEditor").disabled = busy;
      for (const name of ["perspectiveLabel", "perspectiveDescription"]) field<HTMLInputElement>(name).disabled = busy || !customPerspectives.some(item => item.id === setupPerspective.value);
      field<HTMLTextAreaElement>("templateEditor").disabled = busy;
      field<HTMLTextAreaElement>("perspectiveEditor").readOnly = !activeCustom;
      field<HTMLTextAreaElement>("templateEditor").readOnly = !activeCustom;
    };
    /** 历史只切换文章内容，模型设置继续沿用当前工作空间配置。 */
    const showHistory = (visible: boolean): void => {
      finishArticleEditing();
      const previous = historyVisible;
      historyVisible = visible;
      if (visible || previous) { inputUrl.value = ""; persistDraft(); updateActions(); }
      root.querySelector<HTMLElement>(".noosphere__capture")!.hidden = visible;
      root.querySelector<HTMLElement>(".noosphere__work-content")!.hidden = visible;
      role("historyPanel").hidden = !visible;
      for (const [name, selected] of [["showCapture", !visible], ["showHistory", visible]] as const) {
        action(name).classList.toggle("is-active", selected);
        action(name).setAttribute("aria-pressed", String(selected));
      }
      if (visible) renderHistory();
    };
    const loadHistoryArticle = (id: string): boolean => {
      if (busy) return false;
      const entry = this.historyStore.entries.find(item => item.id === id);
      if (!entry?.draft.article) return false;
      finishArticleEditing(); persistDraft(); disposeArticleEditor();
      const restored = structuredClone(entry.draft);
      sourceEditing = false;
      article = restored.article; editorState = restored.editorState; bodyEdited = restored.bodyEdited || false;
      historyId = id;
      inputUrl.value = "";
      markdown.value = restored.markdown;
      reviewedMarkdown = restored.reviewedMarkdown;
      imageDecisions = normalizeImageDecisions(restored.imageDecisions, article!.url);
      reviewInfo = restored.reviewInfo;
      textReviewed = restored.textReviewed ?? (!!reviewInfo || !!reviewedMarkdown);
      target.value = restored.targetDocumentId;
      savedDocumentId = restored.savedDocumentId;
      savedContentChanged = restored.savedContentChanged || false;
      repairImageChoices(restored.imageDecisions);
      renderSavedLocation();
      const perspective = availablePerspective(restored.perspective);
      setDropdown("workPerspective", perspective, false);
      setDropdown("reviewPerspective", perspective, false);
      const language = normalizeOutputLanguage(restored.outputLanguage);
      setDropdown("workOutputLanguage", language, false);
      progressPanel.hidden = true;
      selectedImage = undefined;
      renderSelectedImage();
      renderArticle();
      renderImageDecisions();
      role("articleScroll").scrollTop = 0;
      showHistory(false);
      persistDraft();
      setStatus("已打开历史文章，可继续审阅或导入思源。");
      updateActions();
      return true;
    };
    const renderHistory = (): void => {
      const list = role("historyList");
      list.replaceChildren();
      const query = (role("historySearch") as HTMLInputElement).value.trim().toLocaleLowerCase();
      const entries = [...this.historyStore.entries].sort((a, b) => b.capturedAt - a.capturedAt)
        .filter(entry => [entry.draft.article?.title, entry.draft.article?.url, entry.draft.article?.author].some(value => value?.toLocaleLowerCase().includes(query)));
      role("historyCount").textContent = String(this.historyStore.entries.length);
      role("historyEmpty").hidden = entries.length > 0;
      role("historyEmpty").textContent = query ? "没有找到匹配的文章。" : "暂无历史文章，成功抓取后会自动保留。";
      for (const entry of entries) {
        const source = entry.draft.article!;
        const row = document.createElement("article");
        row.className = "noosphere__history-entry";
        row.dataset.historyId = entry.id;
        const heading = document.createElement("h4"); heading.textContent = source.title;
        const info = document.createElement("p");
        info.textContent = `${new Date(entry.capturedAt).toLocaleString()} · ${entry.draft.savedDocumentId ? "已导入思源" : entry.draft.textReviewed || entry.draft.reviewedMarkdown ? "已审阅" : "待审阅"}${source.author ? ` · ${source.author}` : ""}`;
        const link = document.createElement("p"); link.className = "noosphere__history-url"; link.textContent = source.url;
        const buttons = document.createElement("div"); buttons.className = "noosphere__history-actions";
        for (const [operation, label] of [["view", "查看文章"], ["delete", "删除"]] as const) {
          const button = document.createElement("button");
          button.type = "button"; button.className = "b3-button b3-button--outline";
          button.dataset.historyAction = operation; button.textContent = label; button.disabled = busy;
          button.addEventListener("click", () => {
            if (busy) return;
            if (operation === "delete") {
              confirm("删除历史文章", "删除后将无法从知流历史恢复这篇文章。已导入思源的文档和图片会保留。", () => {
                if (busy || this.uninstalled) return;
                this.historyStore.remove(entry.id);
                if (historyId === entry.id) {
                  article = null; historyId = undefined; markdown.value = ""; reviewedMarkdown = "";
                  imageDecisions = []; reviewInfo = undefined; textReviewed = false; inputUrl.value = "";
                  selectedImage = undefined; target.value = ""; savedDocumentId = ""; savedContentChanged = false; markUnsaved(); progressPanel.hidden = true;
                  persistDraft(); renderArticle(); renderImageDecisions(); renderSelectedImage();
                }
                renderHistory(); updateActions();
                void Promise.all([this.historyStore.flush(), this.draftStore.flush()]).catch(error => showMessage(`删除历史记录保存失败：${String(error)}`, 7000, "error"));
              });
              return;
            }
            loadHistoryArticle(entry.id);
          });
          buttons.append(button);
        }
        row.append(heading, info, link, buttons); list.append(row);
      }
    };
    action("showCapture").addEventListener("click", () => showHistory(false));
    action("showHistory").addEventListener("click", () => showHistory(true));
    role("historySearch").addEventListener("input", renderHistory);
    action("followStream").addEventListener("click", () => {
      if (textFollowComplete) return;
      followStream = !followStream;
      action("followStream").setAttribute("aria-pressed", String(followStream));
      action("followStream").textContent = followStream ? "跟随输出" : "继续跟随";
      streamFollower?.setEnabled(followStream && !dialogClosed);
    });
    const lightbox = role("imageLightbox");
    const renderSelectedImage = (): void => {
      lightbox.hidden = !selectedImage;
      if (!selectedImage || !article) return;
      role("imageTitle").textContent = selectedImage.alt || "文章图片";
      role("imageDescription").textContent = selectedImage.error || selectedImage.description;
      const url = previewUrl(selectedImage.previewUrl || selectedImage.url, article.url, true);
      const image = role("imageLarge") as HTMLImageElement;
      image.alt = selectedImage.alt || "文章图片";
      image.referrerPolicy = "no-referrer";
      if (url) image.src = url;
      else image.removeAttribute("src");
      const link = role("imageSource") as HTMLAnchorElement;
      const source = previewUrl(selectedImage.url, article.url, true);
      link.hidden = !source;
      if (source) link.href = source;
      action("toggleImage").textContent = selectedImage.remove ? "恢复图片" : "移除图片";
    };
    const changeImageChoice = (decision: ImageDecision, remove: boolean): void => {
      if (busy || bodyEditing || savedToTarget()) return;
      reviewedMarkdown ||= markdown.value;
      decision.remove = remove;
      markdown.value = applyImageDecisions(reviewedMarkdown, imageDecisions);
      if (editorState) editorState = applyEditorImageChoices(editorState, markdown.value, imageDecisions);
      markUnsaved();
      renderArticle();
      renderImageDecisions();
      renderSelectedImage();
      persistDraft();
      updateActions();
    };
    const renderImageDecisions = (): void => {
      imageDecisionList.replaceChildren();
      if (!imageDecisions.length && article) imageDecisions = imageInventory(markdown.value, article.url);
      const removed = imageDecisions.filter(item => item.remove).length;
      const reviewed = imageDecisions.filter(item => imageDecisionStatus(item) === "reviewed").length;
      const failed = imageDecisions.filter(item => imageDecisionStatus(item) === "failed").length;
      const pending = imageDecisions.length - reviewed - failed;
      role("assetCount").textContent = String(imageDecisions.length - removed);
      imageDecisionCount.textContent = imageDecisions.length ? `已审阅 ${reviewed} · 待审阅 ${pending} · 失败 ${failed}${removed ? ` · 移除 ${removed}` : ""}` : article ? "这篇文章没有图片。" : "抓取后展示文章图片。";
      for (const [index, decision] of imageDecisions.entries()) {
        const row = document.createElement("div");
        row.className = "noosphere__asset";
        row.classList.toggle("is-removed", decision.remove);
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.imageFull = decision.full;
        button.setAttribute("aria-label", `查看图片 ${index + 1}：${decision.alt || "文章图片"}`);
        button.title = decision.error || decision.description;
        const url = article && previewUrl(decision.previewUrl || decision.url, article.url, true);
        if (url) {
          const preview = document.createElement("img");
          preview.src = url;
          preview.alt = decision.alt || `文章图片 ${index + 1}`;
          preview.loading = "lazy";
          preview.referrerPolicy = "no-referrer";
          preview.addEventListener("error", () => {
            const fallback = document.createElement("span");
            fallback.className = "noosphere__asset-missing";
            fallback.textContent = "图片暂时无法加载";
            preview.replaceWith(fallback);
          }, { once: true });
          button.append(preview);
        }
        const state = document.createElement("span");
        const status = imageDecisionStatus(decision);
        state.textContent = decision.remove ? "已移除" : status === "pending" ? "待审阅" : status === "failed" ? "识别失败" : "已审阅";
        state.className = `noosphere__asset-state is-${status}`;
        button.append(state);
        button.addEventListener("click", () => { selectedImage = decision; renderSelectedImage(); action("closeImage").focus(); });
        const choice = document.createElement("label");
        choice.title = "移除图片";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = decision.remove;
        checkbox.disabled = busy || bodyEditing || savedToTarget();
        checkbox.setAttribute("aria-label", `移除图片 ${index + 1}`);
        checkbox.addEventListener("change", () => changeImageChoice(decision, checkbox.checked));
        choice.append(checkbox);
        row.append(button, choice);
        imageDecisionList.append(row);
      }
    };
    const closeImage = (): void => {
      const full = selectedImage?.full;
      selectedImage = undefined;
      renderSelectedImage();
      Array.from(imageDecisionList.querySelectorAll<HTMLButtonElement>("button")).find(button => button.dataset.imageFull === full)?.focus();
    };
    action("closeImage").addEventListener("click", closeImage);
    action("toggleImage").addEventListener("click", () => { if (selectedImage) changeImageChoice(selectedImage, !selectedImage.remove); });
    lightbox.addEventListener("click", event => { if (event.target === lightbox) closeImage(); });
    lightbox.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.stopPropagation(); closeImage(); }
      if (event.key === "Tab") {
        const buttons = Array.from(lightbox.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]:not([hidden])'));
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    const currentProfile = (): ModelProfile => ({
      modelBaseUrl: field("modelBaseUrl").value.trim(),
      modelKey: field("modelKey").value.trim(),
      modelName: field("modelName").value.trim(),
      modelFormat: modelFormat.value as Settings["modelFormat"],
      modelVisionCapable: modelVisionCapable.checked,
    });
    const readSettings = (): Settings => {
      const profile = currentProfile();
      const activeProvider = modelProvider.value as ProviderId;
      modelProfiles[activeProvider] = profile;
      return {
        topBarPosition: this.settings.topBarPosition,
        reviewPerspective: workPerspective.value,
        outputLanguage: "follow_ui",
        firecrawlKey: field("firecrawlKey").value.trim(),
        ...profile,
        activeProvider,
        customProviders: customProviders.map(item => ({ ...item })),
        providerOrder: orderedProviderIds(customProviders, providerOrder),
        modelProfiles: configuredProfiles(modelProfiles),
        imageProvider: imageProvider.value as Settings["imageProvider"],
        imageReview: !!imageProvider.value,
        customPerspectives: customPerspectives.map(item => ({ ...item, sections: undefined })),
        targetDocumentId: "",
      };
    };
    const cloneSettings = (value: Settings): Settings => JSON.parse(JSON.stringify(value)) as Settings;
    const comparableSettings = ({ targetDocumentId: _targetDocumentId, ...config }: Settings): string => JSON.stringify(config);
    let setupBaseline: Settings | null = null;
    /** 状态使用与离开确认相同的比较规则，不把显隐和浏览空白预设记作修改。 */
    const refreshSettingsState = (): void => {
      const dirty = !!setupBaseline && comparableSettings(readSettings()) !== comparableSettings(setupBaseline);
      role("settingsState").textContent = savingSettings ? "保存中…" : dirty ? "未保存" : "已保存";
      action("settings").textContent = savingSettings ? "保存中…" : "保存";
      action("settings").disabled = busy || savingSettings;
      action("toggleSettings").disabled = busy || savingSettings;
    };
    // 在字段及按钮处理完成后刷新，兼容隐藏选择框和拖动排序的状态变化。
    for (const event of ["input", "change", "click", "drop", "keydown"]) {
      setup.addEventListener(event, () => queueMicrotask(refreshSettingsState), true);
    }
    const saveSettings = async (): Promise<Settings> => {
      const next = readSettings();
      for (const perspective of next.customPerspectives) validatePerspective(perspective);
      // 文章语言只随草稿和历史保留，保存设置时移除旧版全局默认值。
      const { outputLanguage: _outputLanguage, ...storedSettings } = next;
      const result = await this.saveOwnedData(STORAGE_NAME, storedSettings) as { code?: number; msg?: string };
      if (this.uninstalled) throw new Error("知流已卸载");
      if (result?.code !== 0) throw new Error(result?.msg || "配置保存失败");
      this.settings = next;
      setupBaseline = cloneSettings(next);
      refreshSettingsState();
      return next;
    };
    /** 取消正在进行的审阅时恢复临时快照，图片取舍和来源元数据一起恢复。 */
    const restoreReview = (backup: ReviewSnapshot): void => {
      const state = structuredClone(backup);
      article = state.article; markdown.value = state.markdown; reviewedMarkdown = state.reviewedMarkdown;
      imageDecisions = state.imageDecisions; reviewInfo = state.reviewInfo; textReviewed = state.textReviewed ?? (!!reviewInfo || !!reviewedMarkdown);
      editorState = state.editorState; bodyEdited = state.bodyEdited || false;
      savedDocumentId = state.savedDocumentId;
      savedContentChanged = state.savedContentChanged || false;
      renderSavedLocation();
      streamingMarkdown = ""; selectedImage = undefined;
      renderArticle(); renderImageDecisions(); renderSelectedImage();
    };
    action("cancelReview").addEventListener("click", () => {
      const cancel = this.cancelActiveReview;
      const controller = reviewController;
      if (!reviewing || !cancel || !controller || controller.signal.aborted || cancelConfirmationOpen) return;
      cancelConfirmationOpen = true;
      // 弹窗属于当前这一轮审阅；迟到的确认不能撤回已完成结果或取消下一轮。
      confirm("取消本次审阅？", "取消后，本次已经输出的内容和图片审阅进度将被丢弃，文章会恢复到本次审阅开始前的内容。确定要取消吗？", () => {
        cancelConfirmationOpen = false;
        if (reviewing && this.cancelActiveReview === cancel && reviewController === controller && !controller.signal.aborted) cancel();
      }, () => { cancelConfirmationOpen = false; });
    });
    const run = async (label: string, operation: (signal?: AbortSignal) => Promise<string>): Promise<void> => {
      if (busy) return;
      busy = true;
      reviewing = label === "AI 审阅";
      const beforeReview: ReviewSnapshot | undefined = reviewing && article ? structuredClone({ article, markdown: markdown.value, reviewedMarkdown, imageDecisions, reviewInfo, textReviewed, savedDocumentId, savedContentChanged, editorState, bodyEdited }) : undefined;
      const controller = reviewing ? new AbortController() : undefined;
      reviewController = controller;
      let removeAbortListener: (() => void) | undefined;
      const cancelled = controller ? new Promise<never>((_resolve, reject) => {
        const abort = (): void => reject(new RequestCancelledError());
        controller.signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener("abort", abort);
      }) : undefined;
      const cancelReview = (): void => {
        if (!controller || controller.signal.aborted) return;
        controller.abort();
        if (this.uninstalled) return;
        if (beforeReview) restoreReview(beforeReview);
        role("streamNotice").hidden = true;
        persistDraft(); updateActions();
      };
      if (controller) this.cancelActiveReview = cancelReview;
      this.captureBusy = true;
      if (reviewing) role("reviewState").textContent = "审阅中";
      if (reviewing) setReviewProgress("正文审阅", null, "等待模型返回");
      if (reviewing) {
        streamingMarkdown = ""; previewMarkdown = ""; imageStage = ""; followStream = true; textFollowComplete = false; streamBodyValidated = false;
        action("followStream").setAttribute("aria-pressed", "true");
        action("followStream").textContent = "跟随输出";
      }
      updateActions();
      setStatus(`${label}中…`);
      let successful = false;
      try {
        const pending = operation(controller?.signal);
        const message = await (cancelled ? Promise.race([pending, cancelled]) : pending);
        if (this.uninstalled) return;
        throwIfCancelled(controller?.signal);
        successful = true;
        if (message) setStatus(message, "success");
        else { status.hidden = true; statusText.textContent = ""; }
        if (reviewing && dialogClosed) showMessage(`「${article?.title || "文章"}」${message}`, 7000);
        if (reviewing) {
          const failed = imageDecisions.filter(item => imageDecisionStatus(item) === "failed").length;
          setReviewProgress(failed ? `已结束 · ${failed} 张识别失败` : "审阅完成", 100, "100%");
        }
      } catch (error) {
        if (this.uninstalled) return;
        if (controller?.signal.aborted || error instanceof RequestCancelledError) {
          if (beforeReview) restoreReview(beforeReview);
          setReviewProgress("已取消", 0, "");
          setStatus("审阅已取消。");
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        status.hidden = true; statusText.textContent = "";
        if (reviewing) progressPanel.hidden = true;
        showMessage(`${label}失败：${message}`, 7000, "error");
      } finally {
        if (streamPreviewTimer) clearTimeout(streamPreviewTimer);
        streamPreviewTimer = undefined;
        playback?.stop(); playback = undefined;
        if (!successful || dialogClosed) { streamFollower?.stop(); streamFollower = undefined; }
        removeAbortListener?.();
        if (this.cancelActiveReview === cancelReview) this.cancelActiveReview = null;
        if (reviewController === controller) reviewController = undefined;
        if (this.uninstalled) return;
        busy = false;
        reviewing = false;
        this.captureBusy = false;
        if (dialogClosed) this.resumeCaptureDialog = null;
        streamingMarkdown = "";
        role("streamNotice").hidden = true;
        persistDraft();
        renderArticle();
        updateActions();
        if (successful && !dialogClosed) streamFollower?.finish();
        try { await Promise.all([this.draftStore.flush(), this.historyStore.flush()]); }
        catch (error) { showMessage(`草稿保存失败：${String(error)}`, 7000, "error"); }
      }
    };

    // 重开工作台时复用当前任务和交互节点，不启动第二次请求，也不丢失实时进度。
    this.resumeCaptureDialog = () => {
      if (!dialogClosed || this.uninstalled) return;
      const previousHeader = dialogHeader!;
      dialog = createDialog();
      dialogHeader = dialog.element.querySelector<HTMLElement>(".b3-dialog__header")!;
      dialogHeader.className = previousHeader.className;
      dialogHeader.setAttribute("aria-label", "知流");
      dialogHeader.replaceChildren(...Array.from(previousHeader.childNodes));
      dialog.element.querySelector<HTMLElement>(".noosphere")!.replaceWith(root);
      this.captureDialog = dialog;
      dialogClosed = false;
      if (playback && streamingMarkdown && renderer && article) {
        previewMarkdown = streamingMarkdown;
        playback.update(reviewPreviewText(previewMarkdown, article.url, renderer));
      }
      playback?.setPaused(false);
      renderArticle(); updateActions();
      streamFollower?.setEnabled(followStream && !textFollowComplete && !!playback?.active);
    };

    // Styled listboxes synchronize through hidden inputs so both views share one setting.
    const setDropdown = (name: string, value: string, emitChange = true): void => {
      const control = field<HTMLInputElement>(name);
      if (name === "modelProvider") {
        const changed = control.value !== value;
        control.value = value;
        if (changed && emitChange) control.dispatchEvent(new Event("change"));
        return;
      }
      const option = root.querySelector<HTMLButtonElement>(`[data-select-option="${name}"][data-value="${value}"]`);
      if (!option) return;
      const changed = control.value !== value;
      control.value = value;
      root.querySelector<HTMLElement>(`[data-select-label="${name}"]`)!.textContent = option.textContent;
      root.querySelectorAll<HTMLButtonElement>(`[data-select-option="${name}"]`).forEach(item => item.setAttribute("aria-selected", String(item === option)));
      if (changed && emitChange) control.dispatchEvent(new Event("change"));
    };
    const closeDropdowns = (): void => {
      root.querySelectorAll<HTMLElement>(".noosphere__dropdown-menu").forEach(menu => { menu.hidden = true; });
      root.querySelectorAll<HTMLButtonElement>("[data-select-trigger]").forEach(trigger => trigger.setAttribute("aria-expanded", "false"));
    };
    root.querySelectorAll<HTMLButtonElement>("[data-select-trigger]").forEach(trigger => trigger.addEventListener("click", () => {
      const name = trigger.dataset.selectTrigger!;
      const menu = root.querySelector<HTMLElement>(`[data-dropdown="${name}"] .noosphere__dropdown-menu`)!;
      const opening = menu.hidden;
      closeDropdowns();
      menu.hidden = !opening;
      trigger.setAttribute("aria-expanded", String(opening));
    }));
    root.addEventListener("click", event => {
      const option = (event.target as Element).closest<HTMLButtonElement>("[data-select-option]");
      if (option) { setDropdown(option.dataset.selectOption!, option.dataset.value!); closeDropdowns(); }
    });
    root.querySelectorAll<HTMLElement>(".noosphere__dropdown").forEach(dropdown => dropdown.addEventListener("keydown", event => {
      const keyboard = event as KeyboardEvent;
      const options = Array.from(dropdown.querySelectorAll<HTMLButtonElement>("[data-select-option]"));
      if (keyboard.key === "Escape") {
        closeDropdowns();
        dropdown.querySelector<HTMLButtonElement>("[data-select-trigger]")?.focus();
      } else if (keyboard.key === "ArrowDown" || keyboard.key === "ArrowUp") {
        keyboard.preventDefault();
        const trigger = dropdown.querySelector<HTMLButtonElement>("[data-select-trigger]")!;
        if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = index < 0 ? (keyboard.key === "ArrowDown" ? 0 : options.length - 1) : (index + (keyboard.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
        options[next]?.focus();
      }
    }));
    root.addEventListener("click", event => { if (!(event.target as Element).closest(".noosphere__dropdown")) closeDropdowns(); });
    root.querySelectorAll<HTMLButtonElement>("[data-reveal]").forEach(button => button.addEventListener("click", () => {
      const input = field<HTMLInputElement>(button.dataset.reveal!);
      setSecretVisibility(input, input.type === "password");
    }));
    const modelResults = root.querySelector<HTMLElement>('[data-role="modelResults"]')!;
    const modelOptions = root.querySelector<HTMLElement>('[data-role="modelOptions"]')!;
    const modelSearch = root.querySelector<HTMLInputElement>('[data-role="modelSearch"]')!;
    const renderPerspectiveOptions = (): void => {
      for (const name of ["reviewPerspective", "workPerspective"]) {
        const menu = root.querySelector<HTMLElement>(`[data-dropdown="${name}"] .noosphere__dropdown-menu`)!;
        menu.querySelectorAll('[data-custom-perspective="true"]').forEach(option => option.remove());
        for (const perspective of customPerspectives) {
          const option = document.createElement("button");
          option.type = "button";
          option.setAttribute("role", "option");
          option.dataset.selectOption = name;
          option.dataset.value = perspective.id;
          option.dataset.customPerspective = "true";
          option.textContent = perspective.label;
          menu.append(option);
        }
      }
    };
    const activePerspective = (): ReviewPerspective | null => {
      const id = setupPerspective.value;
      return REVIEW_PERSPECTIVES[id as keyof typeof REVIEW_PERSPECTIVES] || customPerspectives.find(item => item.id === id) || null;
    };
    const refreshPerspectiveEditor = (): void => {
      const perspective = activePerspective();
      const editable = !!perspective && customPerspectives.some(item => item.id === perspective.id);
      root.querySelector<HTMLElement>('[data-role="perspectiveMeta"]')!.hidden = !editable;
      role("builtinPerspectiveHint").hidden = !perspective || editable;
      action("deletePerspective").hidden = !editable;
      const editor = field<HTMLTextAreaElement>("perspectiveEditor");
      editor.disabled = busy;
      editor.readOnly = !editable;
      editor.value = perspective?.prompt || "";
      const templateEditor = field<HTMLTextAreaElement>("templateEditor");
      templateEditor.disabled = busy;
      templateEditor.readOnly = !editable;
      templateEditor.value = perspective?.template || "";
      field<HTMLInputElement>("perspectiveLabel").value = editable ? perspective!.label : "";
      field<HTMLInputElement>("perspectiveDescription").value = editable ? perspective!.description : "";
      root.querySelector<HTMLElement>('[data-role="perspectivePrompt"]')!.hidden = perspectiveTab !== "prompt";
      root.querySelector<HTMLElement>('[data-role="templateBuilder"]')!.hidden = perspectiveTab !== "template";
      action("perspectiveTab").classList.toggle("is-active", perspectiveTab === "prompt");
      action("templateTab").classList.toggle("is-active", perspectiveTab === "template");
    };
    let displayedProvider: ProviderId = this.settings.activeProvider;
    const providerIds = (): ProviderId[] => orderedProviderIds(customProviders, providerOrder);
    let draggingProvider: ProviderId | null = null;
    const clearProviderDrag = (finished = true): void => {
      role("providerList").querySelectorAll<HTMLElement>("[data-provider-id]").forEach(button => {
        delete button.dataset.dropPosition;
        if (finished) button.classList.remove("is-dragging");
      });
    };
    /** 供应商列表只使用文本节点，用户命名不会成为 HTML。 */
    const renderProviderList = (): void => {
      const list = role("providerList");
      list.replaceChildren();
      for (const id of providerIds()) {
        const info = providerInfo(id, customProviders);
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.providerId = id;
        button.setAttribute("aria-pressed", String(id === displayedProvider));
        button.draggable = true;
        button.title = `${info.label}：拖动调整顺序；Alt+↑/↓ 移动`;
        button.disabled = busy;
        const mark = document.createElement("span");
        mark.className = `noosphere__provider-mark noosphere__provider-mark--${isCustomProvider(id) ? "custom" : id}`;
        mark.textContent = providerMark(id, info.label);
        mark.setAttribute("aria-hidden", "true");
        const name = document.createElement("span");
        name.className = "noosphere__provider-name";
        name.textContent = info.label;
        const grip = document.createElement("span");
        grip.className = "noosphere__provider-grip";
        grip.setAttribute("aria-hidden", "true");
        grip.textContent = "⠿";
        button.append(mark, name, grip);
        button.addEventListener("click", () => { if (!busy) setDropdown("modelProvider", id); });
        button.addEventListener("dragstart", event => {
          if (busy) { event.preventDefault(); return; }
          draggingProvider = id;
          event.dataTransfer?.setData("application/x-noosphere-provider", id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          button.classList.add("is-dragging");
        });
        button.addEventListener("dragover", event => {
          if (busy || !draggingProvider || draggingProvider === id) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          clearProviderDrag(false);
          const bounds = button.getBoundingClientRect();
          button.dataset.dropPosition = event.clientY <= bounds.top + bounds.height / 2 ? "before" : "after";
          const viewport = list.getBoundingClientRect();
          if (event.clientY < viewport.top + 28) list.scrollTop -= 12;
          else if (event.clientY > viewport.bottom - 28) list.scrollTop += 12;
        });
        button.addEventListener("dragleave", () => { delete button.dataset.dropPosition; });
        button.addEventListener("drop", event => {
          if (busy || !draggingProvider) return;
          event.preventDefault();
          const bounds = button.getBoundingClientRect();
          providerOrder = moveProvider(providerIds(), draggingProvider, id, event.clientY > bounds.top + bounds.height / 2);
          draggingProvider = null;
          clearProviderDrag();
          renderProviderList();
          renderImageProviderOptions();
        });
        button.addEventListener("dragend", () => { draggingProvider = null; clearProviderDrag(); });
        button.addEventListener("keydown", event => {
          if (busy || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const ids = providerIds();
          const next = ids[ids.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1)];
          if (!next) return;
          providerOrder = moveProvider(ids, id, next, event.key === "ArrowDown");
          renderProviderList();
          renderImageProviderOptions();
          list.querySelector<HTMLButtonElement>(`[data-provider-id="${id}"]`)?.focus();
        });
        list.append(button);
      }
    };
    const renderImageProviderOptions = (): void => {
      modelProfiles[displayedProvider] = currentProfile();
      const menu = root.querySelector<HTMLElement>('[data-dropdown="imageProvider"] .noosphere__dropdown-menu')!;
      menu.querySelectorAll('[data-dynamic-image="true"]').forEach(option => option.remove());
      for (const id of providerIds()) {
        if (!modelProfiles[id]?.modelVisionCapable) continue;
        const option = document.createElement("button");
        option.type = "button";
        option.setAttribute("role", "option");
        option.dataset.selectOption = "imageProvider";
        option.dataset.value = id;
        option.dataset.dynamicImage = "true";
        option.textContent = providerInfo(id, customProviders).label;
        menu.append(option);
      }
      if (imageProvider.value && !modelProfiles[imageProvider.value as ProviderId]?.modelVisionCapable) setDropdown("imageProvider", "");
      else setDropdown("imageProvider", imageProvider.value);
    };
    const renderProviderView = (): void => {
      const id = modelProvider.value as ProviderId;
      const preset = providerInfo(id, customProviders);
      const custom = isCustomProvider(id);
      const info = role("providerDescription");
      info.replaceChildren();
      const mark = document.createElement("span");
      mark.className = `noosphere__provider-mark noosphere__provider-mark--${custom ? "custom" : id}`;
      mark.textContent = providerMark(id, preset.label);
      mark.setAttribute("aria-hidden", "true");
      const text = document.createElement("strong");
      text.textContent = preset.label;
      info.append(mark, text);
      if (preset.keyUrl) {
        const link = document.createElement("a");
        link.href = preset.keyUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "获取 API Key ↗";
        info.append(link);
      }
      role("providerName").hidden = !custom;
      field<HTMLInputElement>("providerName").value = custom ? preset.label : "";
      action("deleteProvider").hidden = !custom;
      action("deleteProvider").dataset.confirm = "";
      action("deleteProvider").textContent = "删除供应商";
      modelResults.hidden = true;
      modelOptions.replaceChildren();
      renderProviderList();
      renderImageProviderOptions();
    };
    /** Rebuild setup from the last saved settings without clearing the current article. */
    const restoreSetup = (saved: Settings): void => {
      customPerspectives = saved.customPerspectives.map(item => ({ ...item }));
      customProviders = saved.customProviders.map(item => ({ ...item }));
      providerOrder = [...saved.providerOrder];
      for (const id of Object.keys(modelProfiles)) delete modelProfiles[id as ProviderId];
      for (const [id, profile] of Object.entries(saved.modelProfiles)) {
        if (profile) modelProfiles[id as ProviderId] = { ...profile };
      }
      role("providerCreator").hidden = true;
      field<HTMLInputElement>("firecrawlKey").value = saved.firecrawlKey;
      setDropdown("modelProvider", saved.activeProvider, false);
      displayedProvider = saved.activeProvider;
      setDropdown("modelFormat", saved.modelFormat, false);
      field<HTMLInputElement>("modelBaseUrl").value = saved.modelBaseUrl;
      field<HTMLInputElement>("modelKey").value = saved.modelKey;
      field<HTMLInputElement>("modelName").value = saved.modelName;
      modelVisionCapable.checked = saved.modelVisionCapable;
      imageProvider.value = saved.imageProvider;
      renderPerspectiveOptions();
      setDropdown("reviewPerspective", saved.reviewPerspective, false);
      setDropdown("workPerspective", saved.reviewPerspective, false);
      refreshPerspectiveEditor();
      renderProviderView();
      secretVisibility.clear();
      root.querySelectorAll<HTMLInputElement>(".noosphere__secret input").forEach(input => {
        setSecretVisibility(input, !input.value);
      });
      setupBaseline = cloneSettings(readSettings());
      refreshSettingsState();
      updateActions();
    };
    modelProvider.addEventListener("change", () => {
      modelProfiles[displayedProvider] = currentProfile();
      displayedProvider = modelProvider.value as ProviderId;
      const next = modelProfiles[displayedProvider] || presetProfile(displayedProvider);
      setDropdown("modelFormat", next.modelFormat);
      field<HTMLInputElement>("modelBaseUrl").value = next.modelBaseUrl;
      const keyInput = field<HTMLInputElement>("modelKey");
      keyInput.value = next.modelKey;
      setSecretVisibility(keyInput, secretVisibility.get(displayedProvider) ?? !next.modelKey);
      field<HTMLInputElement>("modelName").value = next.modelName;
      modelVisionCapable.checked = next.modelVisionCapable;
      renderProviderView();
    });
    action("addProvider").addEventListener("click", () => {
      role("providerCreator").hidden = false;
      role("providerError").hidden = true;
      field<HTMLInputElement>("newProviderName").value = "";
      field<HTMLInputElement>("newProviderName").focus();
    });
    action("cancelProvider").addEventListener("click", () => { role("providerCreator").hidden = true; });
    action("createProvider").addEventListener("click", () => {
      if (busy) return;
      try {
        const label = validateProviderName(field<HTMLInputElement>("newProviderName").value, customProviders);
        const id: ProviderId = `custom_${crypto.randomUUID()}`;
        customProviders.push({ id, label });
        setDropdown("modelProvider", id);
        role("providerCreator").hidden = true;
      } catch (error) {
        role("providerError").textContent = error instanceof Error ? error.message : String(error);
        role("providerError").hidden = false;
      }
    });
    field<HTMLInputElement>("providerName").addEventListener("change", () => {
      const provider = customProviders.find(item => item.id === displayedProvider);
      if (!provider || busy) return;
      try {
        provider.label = validateProviderName(field<HTMLInputElement>("providerName").value, customProviders, provider.id);
        renderProviderView();
      } catch (error) {
        field<HTMLInputElement>("providerName").value = provider.label;
        showMessage(error instanceof Error ? error.message : String(error), 5000, "error");
      }
    });
    action("deleteProvider").addEventListener("click", () => {
      const id = displayedProvider;
      if (busy || !isCustomProvider(id)) return;
      if (action("deleteProvider").dataset.confirm !== id) {
        action("deleteProvider").dataset.confirm = id;
        action("deleteProvider").textContent = "确认删除";
        return;
      }
      // 先切回内置供应商，再清除旧配置，避免切换事件重新写回已删除密钥。
      setDropdown("modelProvider", "kimi_api");
      customProviders = customProviders.filter(item => item.id !== id);
      delete modelProfiles[id];
      if (imageProvider.value === id) setDropdown("imageProvider", "");
      renderProviderView();
    });
    modelVisionCapable.addEventListener("change", () => {
      renderImageProviderOptions();
      if (modelVisionCapable.checked && !imageProvider.value) setDropdown("imageProvider", displayedProvider);
    });
    for (const tab of ["prompt", "template"] as const) action(tab === "prompt" ? "perspectiveTab" : "templateTab").addEventListener("click", () => { perspectiveTab = tab; refreshPerspectiveEditor(); });
    field<HTMLTextAreaElement>("perspectiveEditor").addEventListener("input", () => {
      const perspective = activePerspective();
      if (perspective && customPerspectives.some(item => item.id === perspective.id)) perspective.prompt = field<HTMLTextAreaElement>("perspectiveEditor").value;
    });
    field<HTMLTextAreaElement>("templateEditor").addEventListener("input", () => {
      const perspective = activePerspective();
      if (perspective && customPerspectives.some(item => item.id === perspective.id)) perspective.template = field<HTMLTextAreaElement>("templateEditor").value;
    });
    for (const [name, key] of [["perspectiveLabel", "label"], ["perspectiveDescription", "description"]] as const) field<HTMLInputElement>(name).addEventListener("input", () => {
      const perspective = activePerspective();
      if (perspective && customPerspectives.some(item => item.id === perspective.id)) {
        perspective[key] = field<HTMLInputElement>(name).value;
        renderPerspectiveOptions();
        setDropdown("reviewPerspective", perspective.id);
        setDropdown("workPerspective", perspective.id);
      }
    });
    action("addPerspective").addEventListener("click", () => {
      const source = activePerspective() || REVIEW_PERSPECTIVES.original;
      const perspective = { ...source, id: `custom_${Date.now().toString(36)}`, label: "自定义视角", description: "基于当前视角创建", template: OUTLINE_FORMAT, sections: undefined };
      customPerspectives.push(perspective);
      renderPerspectiveOptions();
      setDropdown("reviewPerspective", perspective.id);
      setDropdown("workPerspective", perspective.id);
      perspectiveTab = "prompt";
      refreshPerspectiveEditor();
      field<HTMLInputElement>("perspectiveLabel").focus();
    });
    action("deletePerspective").addEventListener("click", () => {
      const perspective = activePerspective();
      if (!perspective || !customPerspectives.some(item => item.id === perspective.id)) return;
      if (action("deletePerspective").dataset.confirm !== perspective.id) {
        action("deletePerspective").dataset.confirm = perspective.id;
        action("deletePerspective").textContent = "再次点击删除";
        return;
      }
      customPerspectives = customPerspectives.filter(item => item.id !== perspective.id);
      action("deletePerspective").dataset.confirm = "";
      action("deletePerspective").textContent = "删除视角";
      renderPerspectiveOptions();
      setDropdown("reviewPerspective", "original");
      setDropdown("workPerspective", "original");
      refreshPerspectiveEditor();
    });
    modelSearch.addEventListener("input", () => {
      const query = modelSearch.value.trim().toLowerCase();
      modelOptions.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.hidden = !button.textContent?.toLowerCase().includes(query); });
    });
    modelFormat.addEventListener("change", () => {
      const current = field<HTMLInputElement>("modelBaseUrl");
      if (!current.value.trim()) current.value = providerInfo(modelProvider.value as ProviderId, customProviders).modelBaseUrl;
      modelResults.hidden = true;
      modelOptions.replaceChildren();
    });
    setupPerspective.addEventListener("change", () => { setDropdown("workPerspective", setupPerspective.value); action("deletePerspective").dataset.confirm = ""; action("deletePerspective").textContent = "删除视角"; refreshPerspectiveEditor(); updateActions(); });
    workPerspective.addEventListener("change", () => {
      setDropdown("reviewPerspective", workPerspective.value);
      refreshPerspectiveEditor();
      persistDraft();
      updateActions();
    });
    workOutputLanguage.addEventListener("change", () => { persistDraft(); });
    renderPerspectiveOptions();
    for (const [name, value] of [["modelFormat", this.settings.modelFormat], ["modelProvider", this.settings.activeProvider], ["reviewPerspective", workPerspective.value], ["workPerspective", workPerspective.value]]) setDropdown(name, value, false);
    refreshPerspectiveEditor();
    renderProviderView();
    action("listModels").addEventListener("click", () => {
      void (async () => {
        action("listModels").disabled = true;
        action("listModels").textContent = "正在获取…";
        try {
          const models = await listAvailableModels(readSettings());
          modelOptions.replaceChildren();
          modelSearch.value = "";
          for (const model of models) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = model;
            button.addEventListener("click", () => {
              field<HTMLInputElement>("modelName").value = model;
              modelOptions.querySelectorAll("button").forEach(item => item.classList.toggle("is-selected", item === button));
            });
            modelOptions.append(button);
          }
          root.querySelector<HTMLElement>('[data-role="modelResultsLabel"]')!.textContent = `找到 ${models.length} 个可用模型 · 点击选择`;
          modelResults.hidden = false;
        } catch (error) {
          modelResults.hidden = true;
          showMessage(`获取模型失败：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
        } finally {
          action("listModels").textContent = "获取可用模型";
          updateActions();
        }
      })();
    });
    inputUrl.addEventListener("input", () => { persistDraft(); updateActions(); setStatus(article ? "新文章抓取成功后将替换当前正文。" : "链接已更改，可以抓取文章。"); });
    /** 来源只在用户确定后写入文章，编辑中的输入不进入草稿或历史。 */
    const updateSourceMetadata = (): void => {
      if (!article || busy || !sourceEditing) return;
      article = { ...article, author: sourceAuthor.value.trim(), publishedAt: sourcePublished.value.trim() };
      sourceEditing = false;
      markdown.value = composeArticle(article, markdown.value);
      if (editorState) editorState = { ...editorState, markdown: markdown.value };
      if (reviewedMarkdown) reviewedMarkdown = composeArticle(article, reviewedMarkdown);
      markUnsaved();
      persistDraft();
      renderArticle();
      updateActions();
    };
    action("editSource").addEventListener("click", () => {
      if (!article || busy) return;
      sourceEditing = true; updateActions(); sourceAuthor.focus();
    });
    action("confirmSource").addEventListener("click", updateSourceMetadata);
    target.addEventListener("input", () => { persistDraft(); updateActions(); renderImageDecisions(); });
    action("toggleSettings").addEventListener("click", () => {
      if (setup.hidden) {
        setupBaseline = cloneSettings(readSettings());
        showView("setup");
        refreshSettingsState();
        return;
      }
      if (!this.settings.firecrawlKey) {
        showMessage("请先填写 Firecrawl API Key 并保存。", 7000, "error");
        return;
      }
      if (setupBaseline && comparableSettings(readSettings()) !== comparableSettings(setupBaseline)) {
        confirm("设置尚未保存", "要放弃本次修改并返回工作台吗？", () => {
          restoreSetup(cloneSettings(this.settings));
          showView("workbench");
        });
        return;
      }
      showView("workbench");
    });
    action("settings").addEventListener("click", () => {
      if (busy || savingSettings) return;
      void (async () => {
        savingSettings = true;
        refreshSettingsState();
        try {
          await saveSettings();
        } catch (error) {
          showMessage(`保存配置失败：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
        } finally {
          savingSettings = false;
          refreshSettingsState();
        }
      })();
    });
    action("scrape").addEventListener("click", () => {
      void run("抓取", async () => {
        const settings = await saveSettings();
        if (!settings.firecrawlKey) { showView("setup"); throw new Error("请先配置 Firecrawl API Key"); }
        // 空白工作台允许先选语言；从已有文章开始新抓取时恢复界面语言默认值。
        const language = article ? "follow_ui" : normalizeOutputLanguage(workOutputLanguage.value);
        const nextArticle = await scrapeWithFirecrawl(inputUrl.value, settings.firecrawlKey);
        if (this.uninstalled) throw new Error("知流已卸载");
        progressPanel.hidden = true;
        article = nextArticle; editorState = undefined; bodyEdited = false;
        setDropdown("workOutputLanguage", language, false);
        target.value = ""; savedDocumentId = ""; savedContentChanged = false;
        reviewedMarkdown = "";
        imageDecisions = [];
        reviewInfo = undefined;
        textReviewed = false;
        markUnsaved();
        markdown.value = article.markdown;
        renderImageDecisions();
        historyId = this.historyStore.add(snapshotDraft());
        persistDraft();
        renderArticle();
        return "";
      });
    });
    /** 最后一字已显示后释放滚动控制；图片识别与图片加载不能再拉回文章末尾。 */
    const stopTextFollowing = (): void => {
      if (textFollowComplete) return;
      textFollowComplete = true; followStream = false;
      streamFollower?.stop(); streamFollower = undefined;
      role("streamNotice").hidden = true;
      if (streamBodyValidated) renderArticle();
    };
    /** 完整审阅期间持续显示并保留图片处理结果。 */
    const acceptImageProgress = (result: ImageReviewResult): void => {
      if (this.uninstalled) throw new Error("知流已卸载");
      imageDecisions = result.decisions;
      if (selectedImage) selectedImage = imageDecisions.find(item => item.full === selectedImage?.full);
      markdown.value = applyImageDecisions(reviewedMarkdown, imageDecisions);
      persistDraft(5000);
      renderArticle();
      renderImageDecisions();
      renderSelectedImage();
      const total = imageDecisions.length;
      const completed = imageDecisions.filter(item => imageDecisionStatus(item) !== "pending").length;
      const percent = total ? Math.round(40 + 55 * completed / total) : 95;
      imageStage = `图片审阅 ${completed}/${total}`;
      setReviewProgress(playback?.pending ? `正文输出中 · ${imageStage}` : imageStage, playback?.pending ? null : percent, playback?.pending ? `已输出 ${playback.count} 字` : `${percent}%`);
      setStatus(`图片已审阅 ${result.reviewed}/${imageDecisions.length}。`);
    };
    action("review").addEventListener("click", () => {
      void run("AI 审阅", async signal => {
        const settings = await saveSettings();
        throwIfCancelled(signal);
        if (!article || !markdown.value.trim()) throw new Error("请先抓取文章");
        if (!settings.modelKey || !settings.modelName) { showView("setup"); throw new Error("请先配置模型 API Key 和模型名称"); }
        let textReceived = false;
        streamTitle = article.title;
        streamFollower?.stop();
        streamFollower = new StreamFollowScroll(role("articleScroll"), articlePreview);
        const currentPlayback = new ReviewTextPlayback((_content, count) => {
          if (this.uninstalled || signal?.aborted || dialogClosed) return;
          role("streamNotice").hidden = textFollowComplete;
          const label = !textReceived && currentPlayback.bodyFinished && !currentPlayback.pending ? "正文已输出，等待模型确认" : textReceived || currentPlayback.bodyFinished ? "正文输出中" : "正文生成中";
          setReviewProgress(`${label}${imageStage ? ` · ${imageStage}` : ""}`, null, `已输出 ${count} 字`);
          renderArticle();
          if (currentPlayback.bodyFinished && !currentPlayback.pending) stopTextFollowing();
          else if (!textFollowComplete) streamFollower?.setEnabled(followStream);
        }, signal, article.markdown.length);
        playback = currentPlayback;
        if (dialogClosed) currentPlayback.setPaused(true);
        const acceptText = (result: Awaited<ReturnType<typeof reviewArticleDetailed>>): void => {
          if (this.uninstalled) throw new Error("知流已卸载");
          throwIfCancelled(signal);
          textReceived = true;
          streamBodyValidated = true;
          if (streamPreviewTimer) clearTimeout(streamPreviewTimer);
          streamPreviewTimer = undefined;
          if (currentPlayback.hasText || streamingMarkdown) {
            const content = reviewPlaybackContent(result.markdown, streamTitle);
            streamTitle = content.title; streamingMarkdown = content.markdown; previewMarkdown = content.markdown;
            currentPlayback.markBodyComplete();
            currentPlayback.update(renderer ? reviewPreviewText(content.markdown, article!.url, renderer) : content.markdown);
          }
          article = result.article; editorState = undefined;
          reviewedMarkdown = result.markdown;
          markdown.value = result.markdown;
          imageDecisions = [];
          reviewInfo = { summary: result.summary || "", model: settings.modelName, perspective: settings.reviewPerspective, completedAt: new Date().toISOString() };
          textReviewed = true;
          markUnsaved();
          renderArticle();
          renderImageDecisions();
          persistDraft();
          if (!currentPlayback.pending) stopTextFollowing();
          if (!currentPlayback.pending) setReviewProgress(settings.imageReview ? "图片审阅" : "正文已完成", settings.imageReview ? 40 : 95, settings.imageReview ? "40%" : "95%");
        };
        // 人工编辑后从当前处理稿审阅，未编辑的文章继续使用完整抓取原文。
        const reviewInput = bodyEdited ? markdown.value : article.markdown;
        const result = await reviewArticleDetailed(article, { ...settings, outputLanguage: normalizeOutputLanguage(workOutputLanguage.value) }, reviewInput, {
          signal, onTextReviewed: acceptText, onImageProgress: progress => { throwIfCancelled(signal); acceptImageProgress(progress); },
          onStreamActivity: () => currentPlayback.observeArrival(),
          onTextDelta: response => {
            if (this.uninstalled) throw new Error("知流已卸载");
            throwIfCancelled(signal);
            const partial = partialReviewContent(response, () => {
              if (currentPlayback.bodyFinished) return;
              currentPlayback.markBodyComplete();
              if (!textReceived && !currentPlayback.pending && currentPlayback.hasText) setReviewProgress("正文已输出，等待模型确认", null, `已输出 ${currentPlayback.count} 字`);
            });
            if (!partial.markdown) return;
            streamTitle = partial.title || article!.title;
            streamingMarkdown = partial.markdown;
            if (dialogClosed) return;
            // 一个网络包可含多个 SSE 片段；每帧只排版最新正文，避免重复渲染阻塞吐字。
            streamPreviewTimer ||= setTimeout(() => {
              streamPreviewTimer = undefined;
              if (this.uninstalled || signal?.aborted || dialogClosed) return;
              try {
                previewMarkdown = streamingMarkdown;
                currentPlayback.update(renderer ? reviewPreviewText(previewMarkdown, article!.url, renderer) : previewMarkdown);
                if (currentPlayback.bodyFinished && !currentPlayback.pending) stopTextFollowing();
              }
              catch (error) {
                // 异步排版失败也回到思源消息，并停止当前请求，避免未处理异常或迟到结果。
                showMessage(`AI 审阅显示失败：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
                this.cancelActiveReview?.();
              }
            }, 48);
          },
          onStreamFallback: () => { throwIfCancelled(signal); setReviewProgress("正文审阅", null, "当前思源版本等待完整响应"); },
        });
        if (this.uninstalled) throw new Error("知流已卸载");
        throwIfCancelled(signal);
        // 兼容无进度回调的适配器，最终结果仍由同一入口保留。
        if (!textReceived) acceptText(result);
        await currentPlayback.finish();
        stopTextFollowing();
        throwIfCancelled(signal);
        if (this.uninstalled) throw new Error("知流已卸载");
        currentPlayback.stop(); streamingMarkdown = ""; role("streamNotice").hidden = true;
        article = result.article; editorState = undefined;
        reviewedMarkdown = result.markdown;
        imageDecisions = result.imageDecisions;
        markdown.value = applyImageDecisions(reviewedMarkdown, imageDecisions);
        if (reviewInfo) reviewInfo.completedAt = new Date().toISOString();
        markUnsaved();
        persistDraft();
        renderArticle();
        renderImageDecisions();
        const failedImages = imageDecisions.filter(item => imageDecisionStatus(item) === "failed");
        if (failedImages.length) showMessage(`图片识别有 ${failedImages.length} 张未完成，相关图片已保留。${failedImages[0].error || "未能识别图片"}`, 7000, "error");
        const enrichment = result.metadataAccepted.length ? "，补全了有原文证据的元数据" : "";
        return result.imagesReviewed ? `审阅完成${enrichment}；检查了 ${result.imagesReviewed} 张图片，请核对移除建议。` : `审阅完成${enrichment}，请检查正文。`;
      });
    });
    action("save").addEventListener("click", () => {
      void run("保存", async () => {
        const documentId = target.value.trim();
        await saveSettings();
        if (!article || !markdown.value.trim()) throw new Error("请先抓取文章");
        await validateTargetDocument(documentId);
        if (this.uninstalled) throw new Error("知流已卸载");
        let content = markdown.value;
        let note = "";
        const nativeState = editorState?.markdown === content ? editorState : undefined;
        const result = await localizeMarkdownImages(content, article.url);
        if (this.uninstalled) throw new Error("知流已卸载");
        imageDecisions = localizeImagePreviews(imageDecisions, result.assets || {}, article.url);
        imageDecisions = imageDecisions.map(item => ({ ...item, full: replaceImageAssetRefs(item.full, result.assets || {}) }));
        reviewedMarkdown = replaceImageAssetRefs(reviewedMarkdown, result.assets || {});
        content = result.markdown;
        editorState = nativeState ? localizeEditorState(nativeState, content, result.assets || {}) : undefined;
        markdown.value = content;
        // 本地化完成即保留；后续写入失败也不会丢失正文或重复下载图片。
        persistDraft();
        renderArticle();
        note = `，已保存 ${result.localized} 张图片`;
        if (result.warnings.length) {
          note += `，${result.warnings.length} 张保留原链接`;
          showMessage(`${result.warnings.length} 张图片未能保存到思源，正文仍保留原链接。${result.warnings[0]}`, 7000, "error");
        }
        await appendArticle(documentId, article, content, editorState?.blockDOM);
        savedDocumentId = documentId; savedContentChanged = false;
        renderSavedLocation();
        persistDraft();
        return `已保存到思源${note}。点击“打开文档”查看。`;
      });
    });
    action("openSaved").addEventListener("click", () => {
      if (!savedDocumentId) return;
      openTab({ app: this.app, doc: { id: savedDocumentId } });
      dialog.destroy();
    });
    setDropdown("workOutputLanguage", workOutputLanguage.value, false);
    setupBaseline = cloneSettings(readSettings());
    if (draft && repairImageChoices(draft.imageDecisions)) persistDraft();
    renderArticle();
    renderImageDecisions();
    role("historyCount").textContent = String(this.historyStore.entries.length);
    renderSavedLocation();
    showView(this.settings.firecrawlKey ? "workbench" : "setup");
    updateActions();
    refreshSettingsState();
  }
}

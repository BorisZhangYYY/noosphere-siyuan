/** SiYuan frontend plugin entry and capture workflow. */
import { Dialog, Plugin, confirm, openTab, showMessage } from "siyuan";
import { scrapeWithFirecrawl } from "./crawler/firecrawl";
import { listAvailableModels, reviewArticleDetailed } from "./review/provider";
import { applyImageDecisions, imageDecisionStatus, imageDisplayStatus, imageNeedsReview, imageSourceUnavailable, imageInventory, localizeImagePreviews, normalizeImageDecisions, syncEditedImages, type ImageDecision, type ImageReviewResult } from "./review/images";
import { ImageLocalizationError, localizeMarkdownImages, replaceImageAssetRefs, type LocalizationResult } from "./images/localize";
import { migratePerspective, OUTLINE_FORMAT, REVIEW_PERSPECTIVES, validatePerspective } from "./review/perspectives";
import { configuredProfiles, isCustomProvider, moveProvider, orderedProviderIds, presetProfile, providerInfo, providerMark, restoreProviders, validateProviderName, type ModelProfile, type ProviderId } from "./review/providers";
import { appendArticle, validateTargetDocument } from "./siyuan/writer";
import { checkSavedDocuments } from "./siyuan/saved";
import { articleIdentity, ensureArticleDocument, findArticleDocument } from "./siyuan/destination";
import { classificationRootDocumentId, locateDocument, parentDocumentId } from "./siyuan/location";
import { refreshCategoryIndex } from "./siyuan/tree";
import { CategoryIndexMaintenance } from "./siyuan/index-maintenance";
import { CategoryIndexReadonly } from "./siyuan/index-readonly";
import { ensureClassificationRoot } from "./siyuan/category-management";
import { mountCategoryManager, type CategoryManager } from "./category-manager";
import type { ClassificationResult } from "./review/classify";
import { ClassificationUnavailableError, prepareClassification, validateClassification, type ClassificationPlan } from "./review/classification-plan";
import { removePluginStorage } from "./siyuan/cleanup";
import { DEFAULT_SETTINGS, type Article, type ReviewPerspective, type Settings } from "./types";
import { captureContent } from "./ui";
import { CaptureDraftStore, DRAFT_STORAGE_NAME, type CaptureDraft, type ReviewSnapshot, type ArticleEditorState, storageTimeout } from "./article/draft";
import { throwIfServiceError } from "./siyuan/errors";
import { RequestCancelledError, throwIfCancelled } from "./siyuan/api";
import { CaptureHistoryStore, HISTORY_STORAGE_NAME } from "./article/history";
import { partialReviewContent } from "./review/stream";
import type { ModelActivity } from "./review/reasoning";
import { REVIEW_IDLE_TIMEOUT_MS } from "./siyuan/timeouts";
import { ReviewTextPlayback, reviewPlaybackContent } from "./review/playback";
import { StreamFollowScroll } from "./review/follow";
import { normalizeOutputLanguage } from "./review/language";
import { previewUrl, renderStreamingArticlePreview, reviewPreviewText, type MarkdownRenderer } from "./article/preview";
import { NativeArticleEditor, articleImageHTML, localizeEditorState, applyEditorImageChoices } from "./article/editor";
import { sourcePlatform } from "./article/source";
import { stripSourceMetadata } from "./article/compose";
import { articleTime, restoreArticleTime } from "./article/time";
import { composeArticle } from "./article/compose";
import "./style.css";

const STORAGE_NAME = "settings.json";

export default class NoospherePlugin extends Plugin {
  /** 打开文档时修复已有目录，使改名、移动、删除后的列表也能同步。 */
  private readonly onCategoryDocumentLoaded = (event: { detail: { protyle: { block?: { rootID?: string } } } }): void => {
    const id = event.detail.protyle.block?.rootID;
    if (id) void refreshCategoryIndex(id).catch(error => showMessage(`目录更新失败，重新打开文档可重试：${String(error)}`, 7000, "error"));
  };
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private readonly indexMaintenance = new CategoryIndexMaintenance(() => this.settings,
    error => showMessage(`目录同步失败：${String(error)}`, 7000, "error"));
  private readonly indexReadonly = new CategoryIndexReadonly(document);
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
    this.indexReadonly.start();
    this.eventBus.on("loaded-protyle-static", this.onCategoryDocumentLoaded);
    this.eventBus.on("ws-main", this.indexMaintenance.onMessage);
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
    this.indexMaintenance.schedule();
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
    // 全局配置优先；仅在首次升级且未配置时采用旧草稿的根，历史文章不能改动设置。
    if (saved?.classificationSettingsVersion !== 1) {
      this.settings.rootDocumentId ||= currentDraft?.rootDocumentId?.trim() || "";
      this.settings.autoCreateIndex = saved?.autoCreateIndex ?? currentDraft?.autoCreateIndex ?? false;
      this.settings.classificationSettingsVersion = 1;
      try {
        const { outputLanguage: _outputLanguage, ...config } = this.settings;
        const result = await this.saveOwnedData(STORAGE_NAME, config) as { code?: number; msg?: string };
        if (result?.code !== 0) throw new Error(result?.msg || "配置迁移失败");
      } catch (error) { showMessage(`分类设置迁移尚未保存，请在分类配置中保存：${String(error)}`, 7000, "error"); }
    }
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
    this.indexReadonly.stop();
    this.eventBus.off("loaded-protyle-static", this.onCategoryDocumentLoaded);
    this.eventBus.off("ws-main", this.indexMaintenance.onMessage);
    this.indexMaintenance.stop();
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
    try { const result = await writing; throwIfServiceError(result); return result; } finally { this.ownedWrites.delete(writing); }
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
    // 已抓取文章从历史主动打开；进行中的任务已在上方恢复，不受空白首页影响。
    const draft = this.draftStore.current?.article ? null : this.draftStore.current;
    let article: Article | null = draft?.article || null;
    let busy = false;
    let savingSettings = false;
    let reviewing = false;
    let capturing = false;
    let cancelConfirmationOpen = false;
    let savedDocumentId = draft?.savedDocumentId || "";
    let savedDocumentMissing = draft?.savedDocumentMissing || false;
    let savedContentChanged = draft?.savedContentChanged || false;
    let reviewedMarkdown = draft?.reviewedMarkdown || "";
    let imageDecisions: ImageDecision[] = draft?.imageDecisions.map(item => ({ ...item })) || [];
    if (article) imageDecisions = normalizeImageDecisions(imageDecisions, article.url);
    let reviewInfo: CaptureDraft["reviewInfo"] = draft?.reviewInfo;
    let textReviewed = draft?.textReviewed ?? (!!reviewInfo || !!reviewedMarkdown);
    let reviewCheckpoint: CaptureDraft["reviewCheckpoint"] = draft?.reviewCheckpoint;
    /** 旧历史中的坏图也可直接完成阶段；保留失败提示和用户原有的图片取舍。 */
    const settleImageCheckpoint = (): void => {
      if (textReviewed && reviewCheckpoint?.stage === "images" && !imageDecisions.some(imageNeedsReview)) {
        reviewCheckpoint = { ...reviewCheckpoint, stage: "complete", status: "complete" };
      }
    };
    settleImageCheckpoint();
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
    let openingClassificationRoot = false;
    let streamTitle = article?.title || "";
    let imageStage = "";
    let reviewHasUnresolvedLinks = false;
    let historyVisible = false;
    let selectedImage: ImageDecision | undefined;
    // 插入选择与大图预览独立；正文编辑重建素材时按原始地址保留选择。
    let selectedAssetUrls: string[] = [];
    let persistDraft: (delayMs?: number) => void = () => undefined;
    let categoryManager: CategoryManager | undefined;
    let detachSavedDocumentEvents: () => void = () => undefined;
    let savedStatusRevision = 0;
    const createDialog = (): Dialog => new Dialog({
      title: "知流",
      width: `${Math.min(1360, window.innerWidth - 32)}px`,
      content: captureContent(),
      destroyCallback: () => {
        savedStatusRevision++;
        detachSavedDocumentEvents();
        categoryManager?.dispose(); categoryManager = undefined;
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
    const rootDocument = field<HTMLInputElement>("rootDocumentId");
    const autoCreateIndex = field<HTMLInputElement>("autoCreateIndex");
    let autoSave = draft?.autoSave;
    let indexDocumentId = draft?.indexDocumentId;
    /** 保存方式随文章走；设置里的 saveMode 只是新文章的初值。 */
    const saveMode = (): Settings["saveMode"] =>
      (root.querySelector<HTMLInputElement>('input[data-field="saveMode"][value="auto"]')?.checked ? "auto" : "manual");
    let classification: CaptureDraft["classification"] = draft?.classification;
    const setSaveMode = (mode: Settings["saveMode"]): void => {
      const manual = root.querySelector<HTMLInputElement>('input[data-field="saveMode"][value="manual"]')!;
      const auto = root.querySelector<HTMLInputElement>('input[data-field="saveMode"][value="auto"]')!;
      manual.checked = mode === "manual";
      auto.checked = mode === "auto";
      renderSaveMode();
    };
    /** 自动分类的根目录仅在分类配置管理，文章页隐藏位置字段。 */
    const renderSaveMode = (): void => {
      const auto = saveMode() === "auto";
      const find = (name: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-role="${name}"]`);
      (find("targetField") as HTMLElement).hidden = auto;
      target.readOnly = auto;
      action("retryIndex").hidden = !indexDocumentId;
    };
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
    rootDocument.value = this.settings.rootDocumentId || "";
    autoCreateIndex.checked = this.settings.autoCreateIndex;
    setSaveMode(draft?.saveMode || this.settings.saveMode || "manual");
    inputUrl.value = draft?.url || "";
    markdown.value = draft?.markdown || "";
    for (const name of ["firecrawlKey", "modelBaseUrl", "modelKey", "modelName"] as const) {
      field(name).value = this.settings[name];
    }
    root.querySelectorAll<HTMLInputElement>('input[data-field="saveMode"]').forEach(input => {
      input.addEventListener("change", () => {
        renderSaveMode();
        persistDraft();
        updateActions();
      });
    });
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
      const isSaved = !!savedDocumentId && !savedDocumentMissing;
      saved.hidden = !article;
      saved.querySelector("span")!.textContent = isSaved ? "已保存" : "未保存";
      action("openSaved").hidden = !isSaved;
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
      role("reviewInfo").textContent = reviewInfo ? new Date(reviewInfo.completedAt).toLocaleString() : "";
      role("reviewInfo").title = reviewInfo?.model || "";
      role("reviewInfo").hidden = !role("reviewInfo").textContent;
      renderReviewPipeline();
    };
    const snapshotDraft = (): CaptureDraft => ({ version: 1, updatedAt: Date.now(), url: inputUrl.value, article, markdown: markdown.value,
      reviewedMarkdown, imageDecisions, targetDocumentId: target.value, autoSave, indexDocumentId, perspective: workPerspective.value, outputLanguage: normalizeOutputLanguage(workOutputLanguage.value), savedDocumentId, savedDocumentMissing, savedContentChanged, reviewInfo, textReviewed, reviewCheckpoint, historyId, bodyEdited, saveMode: saveMode(), classification,
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
    const savedToTarget = (): boolean => !!savedDocumentId && !savedDocumentMissing && !savedContentChanged && savedDocumentId === target.value.trim();

    let savedCheck: Promise<void> | undefined;
    let savedCheckQueued = false;
    /** 同步当前文章与全部历史的保存状态；迟到的查询不能覆盖新保存或已删除的历史。 */
    const refreshSavedDocuments = (): Promise<void> => {
      if (dialogClosed || this.uninstalled || busy) return Promise.resolve();
      if (savedCheck) { savedCheckQueued = true; return savedCheck; }
      const revision = savedStatusRevision;
      const entries = this.historyStore.entries.map(entry => ({ id: entry.id, draft: entry.draft }));
      const checkedDocumentId = savedDocumentId;
      savedCheck = (async () => {
        try {
          const availability = await checkSavedDocuments([checkedDocumentId, ...entries.map(entry => entry.draft.savedDocumentId)]);
          if (dialogClosed || this.uninstalled || busy || revision !== savedStatusRevision) return;
          for (const entry of entries) {
            const exists = availability.get(entry.draft.savedDocumentId);
            if (exists === undefined || !!entry.draft.savedDocumentMissing === !exists) continue;
            if (this.historyStore.entries.find(current => current.id === entry.id)?.draft !== entry.draft) continue;
            this.historyStore.update(entry.id, { ...entry.draft, savedDocumentMissing: !exists });
          }
          const exists = availability.get(savedDocumentId);
          if (savedDocumentId === checkedDocumentId && exists !== undefined && savedDocumentMissing === exists) {
            savedDocumentMissing = !exists;
            if (!exists && status.dataset.tone === "success") { status.hidden = true; statusText.textContent = ""; }
            persistDraft();
          }
          renderSavedLocation();
          if (historyVisible) renderHistory();
          updateActions();
        } catch { /* 网络、权限或旧接口异常不清除已保存记录，后续返回工作台时重试。 */ }
        finally {
          savedCheck = undefined;
          if (savedCheckQueued) { savedCheckQueued = false; await refreshSavedDocuments(); }
        }
      })();
      return savedCheck;
    };
    const attachSavedDocumentEvents = (): void => {
      const refresh = (): void => { void refreshSavedDocuments(); };
      const visible = (): void => { if (!document.hidden) refresh(); };
      const changed = (event: CustomEvent<{ cmd?: string }>): void => {
        if (["removeDoc", "removeDocs", "removeBox", "openBox", "closeBox", "syncFinish", "refreshFileTree"].includes(event.detail.cmd || "")) refresh();
      };
      window.addEventListener("focus", refresh);
      document.addEventListener("visibilitychange", visible);
      this.eventBus.on("ws-main", changed);
      this.eventBus.on("sync-end", refresh);
      detachSavedDocumentEvents = () => {
        window.removeEventListener("focus", refresh);
        document.removeEventListener("visibilitychange", visible);
        this.eventBus.off("ws-main", changed);
        this.eventBus.off("sync-end", refresh);
      };
      refresh();
    };

    /** 原生正文变更立即进入恢复缓存；来源和抓取原文独立保留。 */
    const acceptArticleEdit = (state: ArticleEditorState, title: string): void => {
      if (!article || busy || this.uninstalled) return;
      editorState = state; nativeContentKey = state.blockDOM;
      markdown.value = state.markdown;
      article = { ...article, title: title || article.title };
      bodyEdited = true;
      reviewedMarkdown = state.markdown;
      imageDecisions = syncEditedImages(state.markdown, article.url, imageDecisions);
      if (textReviewed && reviewInfo && reviewCheckpoint?.imageReview && imageDecisions.some(imageNeedsReview)) {
        reviewCheckpoint = { ...reviewCheckpoint, stage: "images", status: "paused" };
      }
      settleImageCheckpoint();
      if (selectedImage) selectedImage = imageDecisions.find(item => item.url === selectedImage?.url);
      markUnsaved(); persistDraft(); renderImageDecisions(); updateActions();
      renderSelectedImage();
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
      // 阶段内已有状态与计数，普通过程消息不再重复占据侧栏。
      if (/^(?:AI 审阅中|图片已审阅|已打开历史文章)/.test(message)) { status.hidden = true; statusText.textContent = ""; return; }
      status.hidden = false;
      status.dataset.tone = tone;
      statusText.textContent = message;
    };
    const progressPanel = role("reviewProgress");
    const progressBar = role("reviewProgressBar") as HTMLProgressElement;
    const captureProgress = role("captureProgress");
    let captureProgressTimer: ReturnType<typeof setInterval> | undefined;
    /** 抓取接口一次性返回结果，只展示实际阶段与耗时，不估算完成百分比。 */
    const stopCaptureProgress = (): void => {
      if (captureProgressTimer) clearInterval(captureProgressTimer);
      captureProgressTimer = undefined;
      captureProgress.hidden = true;
    };
    const startCaptureProgress = (): void => {
      stopCaptureProgress();
      const startedAt = Date.now();
      role("captureProgressLabel").textContent = "正在准备抓取";
      role("captureElapsed").textContent = "已等待 0 秒";
      captureProgress.hidden = false;
      captureProgressTimer = setInterval(() => {
        if (this.uninstalled) { stopCaptureProgress(); return; }
        role("captureElapsed").textContent = `已等待 ${Math.floor((Date.now() - startedAt) / 1000)} 秒`;
      }, 1000);
    };
    /** 使用网页端的阶段标签和原生进度条；等待正文响应时显示不确定进度。 */
    const setReviewProgress = (label: string, value: number | null, detail: string): void => {
      progressPanel.hidden = false;
      progressPanel.classList.remove("is-failed");
      role("reviewProgressLabel").textContent = label;
      role("reviewProgressDetail").textContent = detail;
      progressBar.setAttribute("aria-valuetext", `${label}，${detail}`);
      if (value === null) progressBar.removeAttribute("value");
      else progressBar.value = value;
      progressPanel.hidden = !(reviewing && reviewCheckpoint?.stage === "text") && label !== "正在自动保存";
    };
    /** 从旧版历史也可继续图片阶段；仅已确认的完整文字可以成为图片断点。 */
    const canResumeImages = (): boolean => !!article && textReviewed && !!reviewInfo
      && reviewCheckpoint?.stage !== "text"
      && (reviewCheckpoint?.stage === "images" || this.settings.imageReview && imageDecisions.some(imageNeedsReview));
    /** 阶段流程和恢复提示从持久化断点计算，关闭再打开不会误报“审阅完成”。 */
    const renderReviewPipeline = (): void => {
      const textDone = reviewCheckpoint ? reviewCheckpoint.stage !== "text" : textReviewed;
      const textRunning = reviewing && reviewCheckpoint?.stage === "text";
      const imageRunning = reviewing && reviewCheckpoint?.stage === "images";
      const skipped = !(reviewCheckpoint?.imageReview || this.settings.imageReview);
      const actionable = imageDecisions.filter(item => !item.unplaced && !item.remove);
      const done = imageDecisions.filter(item => !imageNeedsReview(item)).length;
      const remaining = actionable.filter(imageNeedsReview).length;
      const imageDone = textDone && !remaining;
      role("textStage").dataset.state = textRunning ? "running" : textDone ? "complete" : reviewCheckpoint ? "paused" : "pending";
      role("textStageState").textContent = textRunning ? "进行中" : textDone ? "已完成" : reviewCheckpoint ? "待重试" : "待开始";
      role("textStageDetail").textContent = "";
      role("textStageNumber").textContent = textDone ? "✓" : "1";
      role("imageStage").dataset.state = imageRunning ? "running" : textDone && (skipped || imageDone) ? "complete" : textDone ? "paused" : "pending";
      role("imageStageState").textContent = !textDone ? "等待文本" : skipped ? "已跳过" : imageRunning ? "进行中" : imageDone ? "已完成" : "待继续";
      role("imageStageNumber").textContent = textDone && (skipped || imageDone) ? "✓" : "2";
      role("imageStageMeter").hidden = !textDone || skipped || !imageDecisions.length;
      role("imageStageDetail").textContent = `${done} / ${imageDecisions.length}`;
      const imageProgress = role("imageStageProgress") as HTMLProgressElement;
      imageProgress.value = imageDecisions.length ? Math.round(100 * done / imageDecisions.length) : 0;
      imageProgress.setAttribute("aria-valuetext", `已处理 ${done} / ${imageDecisions.length} 张`);
      action("reviewText").textContent = "重新审阅";
      action("reviewText").setAttribute("aria-label", "重新审阅文本");
      action("reviewText").hidden = !textDone || reviewing;
      action("review").hidden = textDone || reviewing;
      const cancelButton = action("cancelReview");
      const activeActions = role(streamBodyValidated ? "imageStageActions" : "textStageActions");
      if (cancelButton.parentElement !== activeActions) activeActions.append(cancelButton);
      action("reviewText").disabled = busy || bodyEditing || sourceEditing || !article || !markdown.value.trim();
      action("resumeImages").disabled = busy || bodyEditing || sourceEditing || !canResumeImages();
      action("resumeImages").textContent = done || reviewCheckpoint?.stage === "images" ? "继续审阅" : "开始审阅";
      action("resumeImages").hidden = imageRunning || skipped || imageDone;
      action("resumeImages").setAttribute("aria-label", "继续图片审阅");
      const interrupted = !busy && reviewCheckpoint && reviewCheckpoint.stage !== "complete";
      role("reviewRecovery").hidden = !reviewCheckpoint?.saveFailed;
      role("reviewRecovery").textContent = reviewCheckpoint?.saveFailed ? "自动保存失败，请重试保存。" : "";
      role("reviewState").textContent = reviewing ? "审阅中" : interrupted ? textDone ? "图片待继续" : "文本待重试" : textReviewed ? "已审阅" : "待审阅";
      progressPanel.hidden = !textRunning && !(busy && role("reviewProgressLabel").textContent === "正在自动保存");
    };
    const selectedAssets = (): ImageDecision[] => selectedAssetUrls
      .map(url => imageDecisions.find(item => item.url === url)).filter((item): item is ImageDecision => !!item);
    /** 素材按点击顺序多选，统一添加/移除；更新正文不能打乱顺序或覆盖保存的选区。 */
    const updateAssetSelection = (): void => {
      const selected = selectedAssets();
      selectedAssetUrls = selected.map(item => item.url);
      role("assetToolbar").hidden = !bodyEditing || !imageDecisions.length;
      role("assetSelectionCount").textContent = selected.length ? `已选 ${selected.length} 张` : "单击多选 · 双击预览";
      action("addAssets").disabled = busy || !bodyEditing || !selected.length;
      action("removeAssets").disabled = busy || !bodyEditing || !selected.some(item => !item.remove);
      imageDecisionList.querySelectorAll<HTMLButtonElement>("button[data-image-full]").forEach((button, index) => {
        const decision = imageDecisions.find(item => item.url === button.dataset.imageUrl);
        if (!decision) return;
        const order = selectedAssetUrls.indexOf(decision.url);
        const chosen = bodyEditing && order >= 0;
        button.closest(".noosphere__asset")?.classList.toggle("is-selected", chosen);
        const badge = button.querySelector<HTMLElement>(".noosphere__asset-order")!;
        badge.hidden = !chosen; badge.textContent = String(order + 1);
        if (bodyEditing) button.setAttribute("aria-pressed", String(chosen));
        else button.removeAttribute("aria-pressed");
        button.setAttribute("aria-label", `${bodyEditing ? "选择" : "查看"}图片 ${index + 1}：${decision.alt || "文章图片"}`);
        button.title = bodyEditing ? "单击选择或取消，按选择顺序添加；双击预览" : imageDisplayStatus(decision) === "added" ? "已手动添加到正文" : decision.error || decision.description;
        button.draggable = bodyEditing && !busy;
      });
    };
    const updateActions = (): void => {
      role("articleMode").textContent = bodyEditing ? "编辑中" : "只读";
      action("editArticle").hidden = bodyEditing; action("confirmArticle").hidden = !bodyEditing;
      action("editArticle").disabled = busy || bodyEditing || sourceEditing || !article;
      action("confirmArticle").disabled = busy;
      const activeCustom = customPerspectives.find(item => item.id === setupPerspective.value);
      action("scrape").disabled = busy || bodyEditing || sourceEditing || !inputUrl.value.trim();
      action("scrape").textContent = capturing ? "正在抓取…" : "抓取文章";
      action("review").disabled = busy || bodyEditing || sourceEditing || !article || !markdown.value.trim();
      action("review").textContent = reviewCheckpoint?.stage === "text" ? "重试审阅" : "开始审阅";
      renderReviewPipeline();
      action("cancelReview").hidden = !reviewing;
      action("cancelReview").textContent = streamBodyValidated ? "取消图片审阅" : "取消审阅";
      action("cancelReview").disabled = !reviewing || !!reviewController?.signal.aborted;
      const autoMode = saveMode() === "auto";
      action("save").disabled = busy || bodyEditing || sourceEditing || !article || !markdown.value.trim()
        || (autoMode ? !this.settings.rootDocumentId.trim() : !target.value.trim())
        || (!autoMode && (savedToTarget() || (savedDocumentMissing && savedDocumentId === target.value.trim())));
      action("retryIndex").disabled = busy || !indexDocumentId;
      updateAssetSelection();
      for (const name of ["settings", "toggleSettings", "saveClassification", "showClassification", "openSaved", "listModels", "addPerspective", "deletePerspective", "perspectiveTab", "templateTab", "addProvider", "createProvider", "cancelProvider", "deleteProvider"] as const) action(name).disabled = busy;
      for (const name of ["showCapture", "showHistory"]) action(name).disabled = busy;
      action("openClassificationRoot").disabled = busy || savingSettings || openingClassificationRoot || !rootDocument.value.trim();
      categoryManager?.setDisabled(busy || savingSettings);
      role("historyList").querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = busy; });
      role("providerList").querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = busy; });
      root.querySelectorAll<HTMLButtonElement>("[data-select-trigger], [data-select-option], [data-reveal]").forEach(button => { button.disabled = busy; });
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea").forEach(input => { input.disabled = busy; });
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
    /** 历史只切换文章内容，模型及分类设置继续沿用当前工作空间配置。 */
    const showHistory = (visible: boolean): void => {
      finishArticleEditing();
      const previous = historyVisible;
      historyVisible = visible;
      if (visible || previous) { inputUrl.value = ""; persistDraft(); updateActions(); }
      role("classificationPanel").hidden = true;
      action("showClassification").classList.remove("is-active");
      action("showClassification").setAttribute("aria-pressed", "false");
      root.querySelector<HTMLElement>(".noosphere__capture")!.hidden = visible;
      root.querySelector<HTMLElement>(".noosphere__work-content")!.hidden = visible;
      role("historyPanel").hidden = !visible;
      for (const [name, selected] of [["showCapture", !visible], ["showHistory", visible]] as const) {
        action(name).classList.toggle("is-active", selected);
        action(name).setAttribute("aria-pressed", String(selected));
      }
      if (visible) renderHistory();
      void refreshSavedDocuments();
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
      reviewCheckpoint = restored.reviewCheckpoint;
      reviewHasUnresolvedLinks = !!reviewCheckpoint?.linkRepair?.unresolved;
      textReviewed = restored.textReviewed ?? (!!reviewInfo || !!reviewedMarkdown);
      settleImageCheckpoint();
      target.value = restored.targetDocumentId;
      savedDocumentId = restored.savedDocumentId;
      savedDocumentMissing = restored.savedDocumentMissing || false;
      classification = restored.classification;
      autoSave = restored.autoSave;
      indexDocumentId = restored.indexDocumentId;
      setSaveMode(restored.saveMode || this.settings.saveMode || "manual");
      savedContentChanged = restored.savedContentChanged || false;
      repairImageChoices(restored.imageDecisions);
      renderSavedLocation();
      const perspective = availablePerspective(restored.perspective);
      setDropdown("workPerspective", perspective, false);
      setDropdown("reviewPerspective", perspective, false);
      const language = normalizeOutputLanguage(restored.outputLanguage);
      setDropdown("workOutputLanguage", language, false);
      progressPanel.hidden = true;
      selectedImage = undefined; selectedAssetUrls = [];
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
        info.textContent = `${new Date(entry.capturedAt).toLocaleString()} · ${entry.draft.savedDocumentId ? entry.draft.savedDocumentMissing ? "未保存" : "已保存" : entry.draft.textReviewed || entry.draft.reviewedMarkdown ? "已审阅" : "待审阅"}${source.author ? ` · ${source.author}` : ""}`;
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
                  imageDecisions = []; reviewInfo = undefined; textReviewed = false; reviewCheckpoint = undefined; inputUrl.value = "";
                  selectedImage = undefined; selectedAssetUrls = []; target.value = ""; savedDocumentId = ""; savedDocumentMissing = false; savedContentChanged = false;
                  autoSave = undefined; classification = undefined; indexDocumentId = undefined; renderSaveMode();
                  markUnsaved(); progressPanel.hidden = true;
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
    action("showClassification").addEventListener("click", () => {
      finishArticleEditing(); persistDraft();
      root.querySelector<HTMLElement>(".noosphere__capture")!.hidden = true;
      root.querySelector<HTMLElement>(".noosphere__work-content")!.hidden = true;
      role("historyPanel").hidden = true;
      role("classificationPanel").hidden = false;
      void categoryManager?.refresh();
      for (const name of ["showCapture", "showHistory", "showClassification"]) {
        const selected = name === "showClassification";
        action(name).classList.toggle("is-active", selected);
        action(name).setAttribute("aria-pressed", String(selected));
      }
    });
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
      role("imageDescription").textContent = selectedImage.unplaced ? "原图已保留，正文位置待确认。进入正文编辑后，选中待确认提示或放置光标，再选择素材并点击“添加”；多张图片按选择顺序添加。" : imageDisplayStatus(selectedImage) === "added" ? "已手动添加到正文。" : selectedImage.error || selectedImage.description;
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
    };
    /** 批量添加共用一次原生事务，替换选区或按光标插入，保留用户选图的先后顺序。 */
    action("addAssets").addEventListener("click", () => {
      const decisions = selectedAssets();
      if (busy || !bodyEditing || !decisions.length) return;
      if (!nativeEditor?.insertImages(decisions)) {
        showMessage("请先进入正文编辑，放置光标或选中需要替换的文字。", 5000, "info"); return;
      }
      // 原生事务成功后记录显式添加，已有的识别失败不再覆盖用户操作状态。
      const added = new Set(decisions.map(item => item.url));
      imageDecisions = imageDecisions.map(item => added.has(item.url) ? { ...item, manuallyAdded: true } : item);
      selectedAssetUrls = []; persistDraft(); renderImageDecisions(); renderSelectedImage();
      nativeEditor.focus();
    });
    /** 素材批量移除同时更新原生正文；即使尚未定位，也保留原图以便重新添加。 */
    action("removeAssets").addEventListener("click", () => {
      const decisions = selectedAssets();
      if (busy || !bodyEditing || !decisions.length || !nativeEditor?.removeImages(decisions)) return;
      const removed = new Set(decisions.map(item => item.url));
      imageDecisions = imageDecisions.map(item => removed.has(item.url) ? { ...item, remove: true } : item);
      selectedAssetUrls = [];
      markUnsaved(); persistDraft(); renderImageDecisions(); renderSelectedImage(); updateActions();
      nativeEditor.focus();
    });
    const renderImageDecisions = (): void => {
      imageDecisionList.replaceChildren();
      if (!imageDecisions.length && article) imageDecisions = imageInventory(markdown.value, article.url);
      const removed = imageDecisions.filter(item => item.remove).length;
      const added = imageDecisions.filter(item => imageDisplayStatus(item) === "added").length;
      const reviewed = imageDecisions.filter(item => imageDisplayStatus(item) === "reviewed").length;
      const failed = imageDecisions.filter(item => imageDisplayStatus(item) === "failed").length;
      const pending = imageDecisions.length - removed - reviewed - failed - added;
      role("assetCount").textContent = String(imageDecisions.length - removed);
      imageDecisionCount.textContent = imageDecisions.length ? `${added ? `已添加 ${added} · ` : ""}已审阅 ${reviewed} · 待审阅 ${pending} · 失败 ${failed} · 移除 ${removed}` : article ? "这篇文章没有图片。" : "抓取后展示文章图片。";
      // 人工处理后同步完成摘要，避免素材已添加而顶部仍保留旧的失败数量。
      if (!busy && role("reviewProgressLabel").textContent?.startsWith("已结束 · ")) {
        setReviewProgress(failed ? `已结束 · ${failed} 张识别失败` : "审阅完成", 100, "100%");
      }
      for (const [index, decision] of imageDecisions.entries()) {
        const row = document.createElement("div");
        row.className = "noosphere__asset";
        row.classList.toggle("is-removed", decision.remove);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "noosphere__asset-preview";
        button.dataset.imageFull = decision.full;
        button.dataset.imageUrl = decision.url;
        button.draggable = bodyEditing && !busy;
        button.addEventListener("dragstart", event => {
          const dragging = selectedAssetUrls.includes(decision.url) ? selectedAssets() : [decision];
          const html = article && dragging.map(item => articleImageHTML(item, article!.url)).join("\n");
          if (!bodyEditing || busy || !html || !event.dataTransfer) { event.preventDefault(); return; }
          // 标准 HTML 拖放交给思源 Protyle 的原生处理，保持落点、格式及撤销语义。
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData("text/html", html);
          event.dataTransfer.setData("text/plain", dragging.map(item => item.full).join("\n"));
        });
        button.setAttribute("aria-label", `查看图片 ${index + 1}：${decision.alt || "文章图片"}`);
        button.title = decision.error || decision.description;
        const url = article && previewUrl(decision.previewUrl || decision.url, article.url, true);
        if (url) {
          const preview = document.createElement("img");
          preview.src = url;
          preview.alt = decision.alt || `文章图片 ${index + 1}`;
          preview.loading = "lazy";
          preview.referrerPolicy = "no-referrer";
          preview.draggable = false;
          preview.addEventListener("error", () => {
            const fallback = document.createElement("span");
            fallback.className = "noosphere__asset-missing";
            fallback.textContent = "图片暂时无法加载";
            preview.replaceWith(fallback);
          }, { once: true });
          button.append(preview);
        }
        const state = document.createElement("span");
        const status = imageDisplayStatus(decision);
        state.textContent = { removed: "已移除", unplaced: "待定位", added: "已添加", pending: "待审阅", failed: "识别失败", reviewed: "已审阅" }[status];
        state.className = `noosphere__asset-state is-${status}`;
        button.append(state);
        const order = document.createElement("span");
        order.className = "noosphere__asset-order"; order.setAttribute("aria-hidden", "true"); order.hidden = true;
        button.append(order);
        const previewImage = (): void => { selectedImage = decision; renderSelectedImage(); action("closeImage").focus(); };
        button.addEventListener("click", () => {
          if (busy) return;
          if (!bodyEditing) { previewImage(); return; }
          selectedAssetUrls = selectedAssetUrls.includes(decision.url)
            ? selectedAssetUrls.filter(url => url !== decision.url) : [...selectedAssetUrls, decision.url];
          updateAssetSelection();
        });
        button.addEventListener("dblclick", () => { if (bodyEditing && !busy) previewImage(); });
        row.append(button);
        imageDecisionList.append(row);
      }
      updateAssetSelection();
    };
    const closeImage = (): void => {
      const full = selectedImage?.full;
      selectedImage = undefined;
      renderSelectedImage();
      Array.from(imageDecisionList.querySelectorAll<HTMLButtonElement>("button")).find(button => button.dataset.imageFull === full)?.focus();
    };
    action("closeImage").addEventListener("click", closeImage);
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
        rootDocumentId: this.settings.rootDocumentId,
        classificationSettingsVersion: 1,
        saveMode: saveMode(),
        autoCreateIndex: this.settings.autoCreateIndex,
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
      const result = await storageTimeout(this.saveOwnedData(STORAGE_NAME, storedSettings)) as { code?: number; msg?: string };
      if (this.uninstalled) throw new Error("知流已卸载");
      if (result?.code !== 0) throw new Error(result?.msg || "配置保存失败");
      this.settings = next;
      renderSaveMode();
      setupBaseline = cloneSettings(next);
      refreshSettingsState();
      return next;
    };
    /** 取消正在进行的审阅时恢复临时快照，图片取舍和来源元数据一起恢复。 */
    const restoreReview = (backup: ReviewSnapshot): void => {
      const state = structuredClone(backup);
      article = state.article; markdown.value = state.markdown; reviewedMarkdown = state.reviewedMarkdown;
      imageDecisions = state.imageDecisions; reviewInfo = state.reviewInfo; textReviewed = state.textReviewed ?? (!!reviewInfo || !!reviewedMarkdown);
      reviewCheckpoint = state.reviewCheckpoint;
      settleImageCheckpoint();
      editorState = state.editorState; bodyEdited = state.bodyEdited || false;
      savedDocumentId = state.savedDocumentId;
      savedDocumentMissing = state.savedDocumentMissing || false;
      savedContentChanged = state.savedContentChanged || false;
      renderSavedLocation();
      streamingMarkdown = ""; selectedImage = undefined; selectedAssetUrls = [];
      renderArticle(); renderImageDecisions(); renderSelectedImage();
    };
    action("cancelReview").addEventListener("click", () => {
      const cancel = this.cancelActiveReview;
      const controller = reviewController;
      if (!reviewing || !cancel || !controller || controller.signal.aborted || cancelConfirmationOpen) return;
      cancelConfirmationOpen = true;
      // 弹窗属于当前这一轮审阅；迟到的确认不能撤回已完成结果或取消下一轮。
      confirm(streamBodyValidated ? "取消图片审阅？" : "取消本次审阅？", streamBodyValidated
        ? "正文和已完成的图片结果会保留，只停止剩余图片审阅；本次不会自动保存，可检查后手动保存。确定要取消吗？"
        : "正文尚未完成，取消后会恢复到本次审阅开始前的内容。如果确认时正文已经完成，则会保留正文，只停止图片审阅。确定要取消吗？", () => {
        cancelConfirmationOpen = false;
        if (reviewing && this.cancelActiveReview === cancel && reviewController === controller && !controller.signal.aborted) cancel();
      }, () => { cancelConfirmationOpen = false; });
    });
    const run = async (label: string, operation: (signal?: AbortSignal) => Promise<string>, reviewMode: "all" | "text" | "images" = "all"): Promise<void> => {
      if (busy) return;
      savedStatusRevision++;
      busy = true;
      const isReview = label === "AI 审阅";
      capturing = label === "抓取";
      if (capturing) startCaptureProgress();
      reviewing = isReview;
      const resumingImages = isReview && (reviewMode === "images" || reviewMode === "all" && canResumeImages());
      const beforeReview: ReviewSnapshot | undefined = reviewing && article ? structuredClone({ article, markdown: markdown.value, reviewedMarkdown, imageDecisions, reviewInfo, textReviewed, reviewCheckpoint, savedDocumentId, savedDocumentMissing, savedContentChanged, editorState, bodyEdited }) : undefined;
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
        if (beforeReview && !streamBodyValidated) restoreReview(beforeReview);
        role("streamNotice").hidden = true;
        persistDraft(); updateActions();
      };
      if (controller) this.cancelActiveReview = cancelReview;
      this.captureBusy = true;
      if (reviewing) role("reviewState").textContent = "审阅中";
      if (reviewing) {
        reviewCheckpoint = { stage: resumingImages ? "images" : "text", status: "running", imageReview: resumingImages || this.settings.imageReview,
          linkRepair: resumingImages ? reviewCheckpoint?.linkRepair : undefined };
        persistDraft();
        setReviewProgress(resumingImages ? "图片审阅" : "正文审阅", null, resumingImages ? "正在恢复断点" : "等待模型返回");
      }
      if (reviewing) {
        reviewHasUnresolvedLinks = !!reviewCheckpoint?.linkRepair?.unresolved;
        streamingMarkdown = ""; previewMarkdown = ""; imageStage = ""; followStream = true; textFollowComplete = resumingImages; streamBodyValidated = resumingImages;
        action("followStream").setAttribute("aria-pressed", "true");
        action("followStream").textContent = "跟随输出";
      }
      updateActions();
      if (capturing) { status.hidden = true; statusText.textContent = ""; }
      else setStatus(`${label}中…`);
      let successful = false;
      let autoSaveFailed = false;
      try {
        const pending = operation(controller?.signal);
        let message = await (cancelled ? Promise.race([pending, cancelled]) : pending);
        if (this.uninstalled) return;
        throwIfCancelled(controller?.signal);
        successful = true;
        if (isReview && reviewCheckpoint?.stage === "complete" && saveMode() === "auto" && !reviewHasUnresolvedLinks) {
          // 审阅结果已确认；进入保存阶段后不能再用“取消审阅”恢复旧快照。
          reviewing = false;
          this.cancelActiveReview = null;
          updateActions();
          setReviewProgress("正在自动保存", null, "审阅已完成");
          try { message = await saveArticle(); }
          catch (error) {
            autoSaveFailed = true;
            if (reviewCheckpoint) reviewCheckpoint.saveFailed = true;
            message = "审阅完成，自动保存未完成。文章已保留，可点击“保存文章”重试。";
            showMessage(`自动保存失败：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
          }
          if (this.uninstalled) return;
        }
        if (message) setStatus(message, autoSaveFailed ? "info" : "success");
        else { status.hidden = true; statusText.textContent = ""; }
        if (isReview && dialogClosed) showMessage(`「${article?.title || "文章"}」${message || (reviewCheckpoint?.stage === "images" ? "文本已保留，图片待继续。" : saveMode() === "auto" ? "审阅完成，已保存。" : "审阅完成。")}`, 7000);
        if (isReview) {
          const failed = imageDecisions.filter(item => !item.remove && imageDecisionStatus(item) === "failed").length;
          const paused = reviewCheckpoint?.stage === "images";
          const percent = paused ? Math.round(40 + 55 * imageDecisions.filter(item => imageDecisionStatus(item) === "reviewed").length / Math.max(1, imageDecisions.length)) : 100;
          setReviewProgress(autoSaveFailed ? "自动保存失败" : reviewHasUnresolvedLinks ? "审阅稿已保留 · 引用待确认" : failed ? `已结束 · ${failed} 张识别失败` : paused ? "文本完成 · 图片待继续" : "审阅完成", percent, autoSaveFailed ? "可重试保存" : paused ? "断点已保留" : "100%");
        }
      } catch (error) {
        if (this.uninstalled) return;
        if (controller?.signal.aborted || error instanceof RequestCancelledError) {
          // 完整正文已确认后，仅停止未完成的图片请求，保留文字和已有图片取舍。
          if (streamBodyValidated) {
            if (reviewCheckpoint) reviewCheckpoint.status = "paused";
            setReviewProgress("图片审阅已取消", progressBar.hasAttribute("value") ? progressBar.value : 40, "正文已保留");
            status.hidden = true; statusText.textContent = "";
          } else {
            if (beforeReview) restoreReview(beforeReview);
            setReviewProgress("已取消", 0, "");
            setStatus("审阅已取消。");
          }
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        status.hidden = true; statusText.textContent = "";
        if (reviewing) {
          // 结束同轮其他请求，防止中断后的迟到图片覆盖断点或下一次审阅。
          controller?.abort();
          if (reviewCheckpoint) reviewCheckpoint.status = "paused";
          setReviewProgress(streamBodyValidated ? reviewCheckpoint?.stage === "images" ? "图片审阅中断" : "审阅中断" : "文本审阅中断", null, "断点已保留");
          progressBar.value = streamBodyValidated ? 40 : 0;
          progressPanel.classList.add("is-failed");
        }
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
        capturing = false;
        stopCaptureProgress();
        this.captureBusy = false;
        if (dialogClosed) this.resumeCaptureDialog = null;
        streamingMarkdown = "";
        role("streamNotice").hidden = true;
        persistDraft();
        renderArticle();
        updateActions();
        void refreshSavedDocuments();
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
      attachSavedDocumentEvents();
      mountCategories();
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
    /** 分类配置独立保存，不提交模型设置页尚未保存的编辑。 */
    let classificationSaveConfirmed = false;
    const refreshClassificationState = (): void => {
      const dirty = rootDocument.value.trim() !== this.settings.rootDocumentId || autoCreateIndex.checked !== this.settings.autoCreateIndex;
      if (dirty) classificationSaveConfirmed = false;
      role("classificationState").hidden = !dirty && !classificationSaveConfirmed;
      role("classificationState").textContent = dirty ? "未保存" : classificationSaveConfirmed ? "已保存" : "";
    };
    rootDocument.addEventListener("input", () => { refreshClassificationState(); updateActions(); });
    autoCreateIndex.addEventListener("change", refreshClassificationState);
    // 固定入口直接打开输入框对应的根文档，分类列表失败或仍在加载时也可使用。
    action("openClassificationRoot").addEventListener("click", () => {
      if (busy || savingSettings || openingClassificationRoot || !rootDocument.value.trim()) return;
      const requested = rootDocument.value.trim();
      openingClassificationRoot = true; updateActions();
      void (async () => {
        try {
          const id = await classificationRootDocumentId(await locateDocument(requested));
          if (dialogClosed || requested !== rootDocument.value.trim()) return;
          if (!id) throw new Error("当前思源未启用“顶层笔记本文档”，该笔记本暂时没有可打开的根文档");
          openTab({ app: this.app, doc: { id } });
          dialog.destroy();
        } catch (error) {
          if (!dialogClosed) showMessage(`无法打开根文档：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
        } finally {
          openingClassificationRoot = false;
          if (!dialogClosed) updateActions();
        }
      })();
    });
    const saveClassification = async (): Promise<Settings> => {
      const rootId = rootDocument.value.trim();
      if (rootId) await locateDocument(rootId);
      const next = { ...this.settings, rootDocumentId: rootId, autoCreateIndex: autoCreateIndex.checked };
      const { outputLanguage: _language, ...storedSettings } = next;
      const result = await storageTimeout(this.saveOwnedData(STORAGE_NAME, storedSettings)) as { code?: number; msg?: string };
      if (result?.code !== 0) throw new Error(result?.msg || "分类配置保存失败");
      this.settings = next;
      classificationSaveConfirmed = true;
      if (setupBaseline) { setupBaseline.rootDocumentId = rootId; setupBaseline.autoCreateIndex = next.autoCreateIndex; }
      renderSaveMode(); refreshClassificationState(); refreshSettingsState(); updateActions();
      if (rootId) {
        try { await ensureClassificationRoot(rootId); }
        catch (error) { showMessage(`配置已保存，根文档目录尚未同步；可再次保存重试：${String(error)}`, 7000, "error"); }
      }
      return next;
    };
    refreshClassificationState();
    action("saveClassification").addEventListener("click", () => {
      void run("保存分类配置", async () => { await saveClassification(); return "分类配置已保存"; }).then(() => categoryManager?.refresh());
    });
    const mountCategories = (): void => {
      categoryManager = mountCategoryManager(role("categoryManager"), this.app, () => this.settings, () => this.captureDialog?.destroy());
    };
    mountCategories();
    action("scrape").addEventListener("click", () => {
      void run("抓取", async () => {
        const settings = await saveSettings();
        if (!settings.firecrawlKey) { showView("setup"); throw new Error("请先配置 Firecrawl API Key"); }
        // 空白工作台允许先选语言；从已有文章开始新抓取时恢复界面语言默认值。
        const language = article ? "follow_ui" : normalizeOutputLanguage(workOutputLanguage.value);
        const nextArticle = await scrapeWithFirecrawl(inputUrl.value, settings.firecrawlKey, stage => {
          if (!this.uninstalled) role("captureProgressLabel").textContent = stage === "fetching" ? "正在抓取文章" : "正在整理正文";
        });
        if (this.uninstalled) throw new Error("知流已卸载");
        progressPanel.hidden = true;
        article = nextArticle; editorState = undefined; bodyEdited = false;
        selectedAssetUrls = [];
        setDropdown("workOutputLanguage", language, false);
        target.value = ""; savedDocumentId = ""; savedDocumentMissing = false; savedContentChanged = false;
        autoSave = undefined; classification = undefined; indexDocumentId = undefined; renderSaveMode();
        reviewedMarkdown = "";
        imageDecisions = [];
        reviewInfo = undefined;
        textReviewed = false;
        reviewCheckpoint = undefined;
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
      renderReviewPipeline();
      setStatus(`图片已审阅 ${result.reviewed}/${imageDecisions.length}。`);
    };
    /** 主操作从断点继续，流程节点也可以单独执行文字或图片阶段。 */
    const startReview = (mode: "all" | "text" | "images" = "all"): void => {
      const resumeImages = mode === "images" || mode === "all" && canResumeImages();
      if (mode === "images" && !canResumeImages()) return;
      void run("AI 审阅", async signal => {
        const settings = await saveSettings();
        throwIfCancelled(signal);
        if (!article || !markdown.value.trim()) throw new Error("请先抓取文章");
        if (!resumeImages && (!settings.modelKey || !settings.modelName)) { showView("setup"); throw new Error("请先配置模型 API Key 和模型名称"); }
        // 自动模式先检查锚点，配置错误时不消耗模型请求。
        if (saveMode() === "auto") {
          if (!settings.rootDocumentId) throw new Error("请先在分类配置中配置分类根目录");
          await locateDocument(settings.rootDocumentId, signal);
        }
        throwIfCancelled(signal);
        let textReceived = resumeImages;
        let responseDelayed = false;
        let modelActivity: ModelActivity = "waiting";
        let lastModelProgressAt = Date.now();
        streamTitle = article.title;
        streamFollower?.stop();
        if (!resumeImages) streamFollower = new StreamFollowScroll(role("articleScroll"), articlePreview);
        const currentPlayback = new ReviewTextPlayback((_content, count) => {
          if (this.uninstalled || signal?.aborted || dialogClosed) return;
          role("streamNotice").hidden = textFollowComplete;
          const label = !textReceived && currentPlayback.bodyFinished && !currentPlayback.pending ? "正文已输出，等待模型确认" : textReceived || currentPlayback.bodyFinished ? "正文输出中" : "正文生成中";
          if (!responseDelayed && modelActivity !== "thinking") setReviewProgress(`${label}${imageStage ? ` · ${imageStage}` : ""}`, null, `已输出 ${count} 字`);
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
          modelActivity = "text"; responseDelayed = false;
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
          imageDecisions = result.imageDecisions;
          reviewHasUnresolvedLinks = !!result.linkRepair?.unresolved;
          reviewInfo = { summary: result.summary || "", model: settings.modelName, perspective: settings.reviewPerspective, completedAt: new Date().toISOString() };
          textReviewed = true;
          const imageReview = settings.imageReview && settings.reviewPerspective !== "raw";
          reviewCheckpoint = { stage: imageReview && result.imageDecisions.some(imageNeedsReview) ? "images" : "complete",
            status: mode === "text" ? "paused" : "running", imageReview, linkRepair: result.linkRepair };
          updateActions();
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
          signal, textOnly: mode === "text",
          resumeText: resumeImages ? { article, markdown: reviewedMarkdown || markdown.value, summary: reviewInfo?.summary || "",
            metadataAccepted: [], imageDecisions, imagesReviewed: imageDecisions.filter(item => imageDecisionStatus(item) === "reviewed").length,
            imageWarnings: [], linkRepair: reviewCheckpoint?.linkRepair } : undefined,
          onTextReviewed: acceptText, onImageProgress: progress => { throwIfCancelled(signal); acceptImageProgress(progress); },
          onLinkRepair: attempt => setReviewProgress(`链接局部修复 ${attempt}/3`, null, "仅修复引用编号"),
          onSlowResponse: () => {
            throwIfCancelled(signal);
            if (this.uninstalled) return;
            responseDelayed = true;
            setReviewProgress("模型响应较慢", null, "可继续等待或取消");
          },
          onStreamActivity: () => {
            currentPlayback.observeArrival();
          },
          onModelActivity: activity => {
            if (textReceived || this.uninstalled || signal?.aborted) return;
            // 仅实际的思考/正文输出表示生成进展；元数据和心跳不冒充“正在思考”。
            if (activity === "thinking" || activity === "text") {
              modelActivity = activity; lastModelProgressAt = Date.now(); responseDelayed = false;
              setReviewProgress(activity === "thinking" ? "模型思考中" : currentPlayback.bodyFinished ? "正文已输出，等待模型确认" : "正文生成中", null,
                currentPlayback.hasText ? `已输出 ${currentPlayback.count} 字` : activity === "thinking" ? "尚未生成正文" : "正在生成审阅稿");
            } else if (modelActivity === "waiting" || responseDelayed || Date.now() - lastModelProgressAt >= REVIEW_IDLE_TIMEOUT_MS) {
              modelActivity = "waiting"; responseDelayed = false;
              setReviewProgress("等待模型输出", null, "已连接，等待思考或正文");
            }
          },
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
        if (reviewInfo && !resumeImages) reviewInfo.completedAt = new Date().toISOString();
        const remainingImages = settings.imageReview && imageDecisions.some(imageNeedsReview);
        reviewCheckpoint = { stage: remainingImages ? "images" : "complete", status: remainingImages ? "paused" : "complete",
          imageReview: settings.imageReview && settings.reviewPerspective !== "raw", linkRepair: result.linkRepair };
        markUnsaved();
        persistDraft();
        renderArticle();
        renderImageDecisions();
        const failedImages = imageDecisions.filter(item => imageDecisionStatus(item) === "failed" && !imageSourceUnavailable(item));
        if (failedImages.length) showMessage(`图片识别有 ${failedImages.length} 张未完成，相关图片已保留。${failedImages[0].error || "未能识别图片"}`, 7000, "error");
        if (result.linkRepair?.unresolved) return `审阅稿已保留，${result.linkRepair.unresolved} 处引用待确认；原图保留在素材中，可手动插入。${saveMode() === "auto" ? "本次未自动保存，请确认后手动保存。" : "请确认后保存。"}`;
        return "";
      }, mode);
    };
    action("review").addEventListener("click", () => startReview());
    action("reviewText").addEventListener("click", () => startReview("text"));
    action("resumeImages").addEventListener("click", () => startReview("images"));
    /** 手动点击与审阅后自动保存共用同一流程；目录失败不会抹掉已成功的落库记录。 */
    const saveArticle = async (): Promise<string> => {
      const autoMode = saveMode() === "auto";
      const manualDocumentId = target.value.trim();
      const settings = await saveSettings();
      const rootDocumentId = settings.rootDocumentId;
      if (autoMode && !rootDocumentId) throw new Error("请先在分类配置中配置分类根目录");
      if (!article || !markdown.value.trim()) throw new Error("请先抓取文章");
      let anchor = autoMode ? await locateDocument(rootDocumentId) : undefined;
      let classificationPlan: ClassificationPlan | undefined;
      /** 分类模型失败立即退出保存，不再进入图片下载或默认落库。 */
      const classifyOrRelease = async (operation: () => Promise<ClassificationPlan>): Promise<ClassificationPlan> => {
        try { return await operation(); }
        catch (error) {
          if (error instanceof ClassificationUnavailableError) {
            setSaveMode("manual"); persistDraft();
            throw new Error(`${error.message}。已切换手动指定，请选择保存位置后重试。`);
          }
          throw error;
        }
      };
      if (!autoMode) await validateTargetDocument(manualDocumentId);
      if (this.uninstalled) throw new Error("知流已卸载");
      let decision: ClassificationResult = { categoryId: null, confidence: 0, reason: "没有已配置的分类" };
      let parentId = rootDocumentId;
      let existingId: string | undefined;
      if (anchor) {
        const boundId = autoSave?.rootId === anchor.id && autoSave.sourceKey === articleIdentity(article) ? autoSave.documentId : undefined;
        // 删除后的旧绑定不再阻止重新归档；接口异常仍停止保存，避免误建重复文章。
        const binding = boundId && (await checkSavedDocuments([boundId])).get(boundId) !== false ? boundId : undefined;
        const existing = await findArticleDocument(anchor, article, binding);
        if (existing) {
          existingId = existing.id;
          parentId = parentDocumentId(existing);
          decision = classification || { categoryId: parentId === anchor.id ? null : parentId, confidence: 1, reason: "更新此前自动保存的文章" };
        } else {
          setStatus("正在选择分类…");
          classificationPlan = await classifyOrRelease(() => prepareClassification(rootDocumentId, article!, markdown.value, this.settings));
          anchor = classificationPlan.root;
          decision = classificationPlan.decision;
          parentId = decision.categoryId || anchor.id;
        }
      }
      if (this.uninstalled) throw new Error("知流已卸载");
      let content = markdown.value;
      const nativeState = editorState?.markdown === content ? editorState : undefined;
      setStatus("正在保存图片…");
      const acceptLocalized = (result: LocalizationResult): void => {
        if (this.uninstalled) throw new Error("知流已卸载");
        imageDecisions = localizeImagePreviews(imageDecisions, result.assets || {}, article!.url);
        imageDecisions = imageDecisions.map(item => ({ ...item, full: replaceImageAssetRefs(item.full, result.assets || {}) }));
        reviewedMarkdown = replaceImageAssetRefs(reviewedMarkdown, result.assets || {});
        content = result.markdown;
        editorState = nativeState ? localizeEditorState(nativeState, content, result.assets || {}) : undefined;
        if (markdown.value !== content) markUnsaved();
        markdown.value = content;
        persistDraft(); renderArticle();
      };
      let result: LocalizationResult;
      try { result = await localizeMarkdownImages(content, article.url, imageDecisions.filter(imageSourceUnavailable).map(item => item.url)); }
      catch (error) {
        if (error instanceof ImageLocalizationError) acceptLocalized(error.partial);
        throw error;
      }
      acceptLocalized(result);
      if (result.warnings.length) {
        showMessage(`${result.warnings.length} 张图片未能保存到思源，正文仍保留原链接。${result.warnings[0]}`, 7000, "error");
      }
      if (anchor) {
        if (classificationPlan) {
          classificationPlan = await classifyOrRelease(() => validateClassification(classificationPlan!, article!, content, this.settings));
          anchor = classificationPlan.root; decision = classificationPlan.decision;
          parentId = decision.categoryId || anchor.id;
        }
        const rootId = anchor.id;
        const sourceKey = articleIdentity(article);
        setStatus("正在写入文章…");
        const written = await ensureArticleDocument(parentId, article, content, {
          root: anchor, existingId, blockDOM: editorState?.blockDOM,
          onCreated: documentId => {
            autoSave = { rootId, documentId, sourceKey };
            savedDocumentId = documentId; savedDocumentMissing = false; savedContentChanged = true;
            persistDraft(); renderSavedLocation();
          },
        });
        classification = decision;
        autoSave = { rootId: anchor.id, documentId: written.documentId, sourceKey };
        savedDocumentId = written.documentId; savedDocumentMissing = false; savedContentChanged = false;
        if (reviewCheckpoint?.saveFailed) { reviewCheckpoint.saveFailed = false; setReviewProgress("审阅完成", 100, "已保存"); }
        // 未启用笔记本根文档时，笔记本本身没有可放目录块的正文。
        indexDocumentId = written.parentId === anchor.notebook ? undefined : written.parentId;
        persistDraft(); renderSavedLocation(); renderSaveMode();
        if (indexDocumentId) {
          try {
            await refreshCategoryIndex(indexDocumentId, { create: this.settings.autoCreateIndex });
            indexDocumentId = undefined;
          } catch (error) {
            showMessage(`文章已保存，目录更新失败：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
          }
        }
        persistDraft(); renderSaveMode();
        try { await ensureClassificationRoot(anchor.id); }
        catch (error) { showMessage(`文章已保存，根文档目录更新失败，可在分类管理中重试：${String(error)}`, 7000, "error"); }
        return "";
      }
      setStatus("正在写入文章…");
      await appendArticle(manualDocumentId, article, content, editorState?.blockDOM);
      savedDocumentId = manualDocumentId; savedDocumentMissing = false; savedContentChanged = false;
      if (reviewCheckpoint?.saveFailed) { reviewCheckpoint.saveFailed = false; setReviewProgress("审阅完成", 100, "已保存"); }
      renderSavedLocation(); persistDraft();
      return "";
    };
    action("save").addEventListener("click", () => { void run("保存", saveArticle); });
    action("retryIndex").addEventListener("click", () => {
      void run("更新目录", async () => {
        if (!indexDocumentId) return "";
        await refreshCategoryIndex(indexDocumentId, { create: this.settings.autoCreateIndex });
        indexDocumentId = undefined; persistDraft(); renderSaveMode();
        return "目录已更新。";
      });
    });
    action("openSaved").addEventListener("click", () => {
      const documentId = savedDocumentId;
      if (!documentId || savedDocumentMissing) return;
      void refreshSavedDocuments().then(() => {
        if (dialogClosed || this.uninstalled || savedDocumentMissing || savedDocumentId !== documentId) return;
        openTab({ app: this.app, doc: { id: documentId } });
        dialog.destroy();
      });
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
    attachSavedDocumentEvents();
  }
}

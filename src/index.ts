/** SiYuan frontend plugin entry and capture workflow. */
import { Dialog, Plugin, confirm, getActiveEditor, openTab, showMessage } from "siyuan";
import { scrapeWithFirecrawl } from "./crawler/firecrawl";
import { listAvailableModels, reviewArticleDetailed } from "./review/provider";
import { applyImageDecisions, type ImageDecision } from "./review/images";
import { localizeMarkdownImages } from "./images/localize";
import { migratePerspective, OUTLINE_FORMAT, REVIEW_PERSPECTIVES, validatePerspective } from "./review/perspectives";
import { presetProfile, PROVIDER_ORDER, PROVIDER_PRESETS, restoreProviders, type ModelProfile, type ProviderId } from "./review/providers";
import { appendArticle, validateTargetDocument } from "./siyuan/writer";
import { DEFAULT_SETTINGS, type Article, type ReviewPerspective, type Settings } from "./types";
import { captureContent } from "./ui";
import "./style.css";

const STORAGE_NAME = "settings.json";

export default class NoospherePlugin extends Plugin {
  private settings: Settings = { ...DEFAULT_SETTINGS };
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
    this.settings = { ...DEFAULT_SETTINGS, ...(saved || {}), ...restoreProviders(saved), reviewPerspective: saved?.reviewPerspective && saved.reviewPerspective !== "raw" && saved.reviewPerspective !== "legacy_guidance" ? saved.reviewPerspective : "original", customPerspectives };
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
    try { await this.saveData(STORAGE_NAME, this.settings); }
    catch (error) { showMessage(`知流位置保存失败：${String(error)}`, 5000, "error"); }
  }

  onunload(): void {
    document.removeEventListener("dragover", this.onTopBarDragOver);
    document.removeEventListener("drop", this.onTopBarDrop);
  }

  /** Open onboarding for a new workspace, otherwise show the capture workbench. */
  private openCaptureDialog(): void {
    let article: Article | null = null;
    let busy = false;
    let savedDocumentId = "";
    let reviewedMarkdown = "";
    let imageDecisions: ImageDecision[] = [];
    const activeDocumentId = getActiveEditor()?.protyle?.block?.rootID;
    const dialog = new Dialog({
      title: "知流",
      width: `${Math.min(1360, window.innerWidth - 32)}px`,
      content: captureContent(),
    });
    const dialogHeader = dialog.element.querySelector<HTMLElement>(".b3-dialog__header");
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
    const markdown = field<HTMLTextAreaElement>("markdown");
    const imageDecisionPanel = root.querySelector<HTMLElement>('[data-role="imageDecisions"]')!;
    const imageDecisionList = root.querySelector<HTMLElement>('[data-role="imageDecisionList"]')!;
    const imageDecisionCount = root.querySelector<HTMLElement>('[data-role="imageDecisionCount"]')!;
    const inputUrl = field<HTMLInputElement>("url");
    const target = field<HTMLInputElement>("targetDocumentId");
    const setupPerspective = field<HTMLInputElement>("reviewPerspective");
    const workPerspective = field<HTMLInputElement>("workPerspective");
    const modelProvider = field<HTMLInputElement>("modelProvider");
    const imageProvider = field<HTMLInputElement>("imageProvider");
    const modelFormat = field<HTMLInputElement>("modelFormat");
    const modelVisionCapable = field<HTMLInputElement>("modelVisionCapable");

    // Show a fixed set of dots for stored keys without exposing their lengths.
    const syncSecretPreview = (input: HTMLInputElement): void => {
      const wrapper = input.closest<HTMLElement>(".noosphere__secret")!;
      wrapper.classList.toggle("has-value", Boolean(input.value));
    };
    target.value = this.settings.targetDocumentId;
    for (const name of ["firecrawlKey", "modelBaseUrl", "modelKey", "modelName"] as const) {
      field(name).value = this.settings[name];
    }
    root.querySelectorAll<HTMLInputElement>(".noosphere__secret input").forEach(input => {
      syncSecretPreview(input);
      input.addEventListener("input", () => syncSecretPreview(input));
    });
    modelFormat.value = this.settings.modelFormat;
    modelVisionCapable.checked = this.settings.modelVisionCapable;
    modelProvider.value = this.settings.activeProvider;
    imageProvider.value = this.settings.imageProvider;
    setupPerspective.value = this.settings.reviewPerspective;
    workPerspective.value = this.settings.reviewPerspective;
    let customPerspectives: ReviewPerspective[] = this.settings.customPerspectives.map(item => ({ ...item }));
    const modelProfiles: Settings["modelProfiles"] = { ...this.settings.modelProfiles };
    let perspectiveTab: "prompt" | "template" = "prompt";

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
    const setStage = (stage: "scrape" | "review" | "save", state: "active" | "done" | "idle"): void => {
      const element = root.querySelector<HTMLElement>(`[data-stage="${stage}"]`)!;
      element.dataset.state = state;
    };
    const setStatus = (message: string, tone: "info" | "success" = "info"): void => {
      status.dataset.tone = tone;
      statusText.textContent = message;
    };
    const updateActions = (): void => {
      const activeCustom = customPerspectives.find(item => item.id === setupPerspective.value);
      action("scrape").disabled = busy || !inputUrl.value.trim();
      action("review").disabled = busy || !article || !markdown.value.trim() || workPerspective.value === "raw";
      action("save").disabled = busy || !article || !markdown.value.trim() || !target.value.trim();
      for (const name of ["current", "settings", "toggleSettings", "openSaved", "listModels", "addPerspective", "deletePerspective", "perspectiveTab", "templateTab"] as const) action(name).disabled = busy;
      root.querySelectorAll<HTMLButtonElement>("[data-select-trigger], [data-select-option], [data-reveal]").forEach(button => { button.disabled = busy; });
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea").forEach(input => { input.disabled = busy; });
      field<HTMLTextAreaElement>("perspectiveEditor").disabled = busy;
      for (const name of ["perspectiveLabel", "perspectiveDescription"]) field<HTMLInputElement>(name).disabled = busy || !customPerspectives.some(item => item.id === setupPerspective.value);
      field<HTMLTextAreaElement>("templateEditor").disabled = busy;
      field<HTMLTextAreaElement>("perspectiveEditor").readOnly = !activeCustom;
      field<HTMLTextAreaElement>("templateEditor").readOnly = !activeCustom;
    };
    const clearArticle = (): void => {
      article = null;
      reviewedMarkdown = "";
      imageDecisions = [];
      imageDecisionPanel.hidden = true;
      imageDecisionList.replaceChildren();
      savedDocumentId = "";
      saved.hidden = true;
      markdown.value = "";
      markdown.hidden = true;
      empty.hidden = false;
      meta.textContent = "";
      for (const stage of ["scrape", "review", "save"] as const) setStage(stage, "idle");
      updateActions();
    };
    const renderImageDecisions = (): void => {
      imageDecisionList.replaceChildren();
      imageDecisionPanel.hidden = !imageDecisions.length;
      if (!imageDecisions.length) return;
      const removed = imageDecisions.filter(item => item.remove).length;
      imageDecisionCount.textContent = removed + " 张待移除 · " + imageDecisions.length + " 张已列出";
      for (const decision of imageDecisions) {
        const row = document.createElement("div");
        row.className = "noosphere__image-decision";
        if (/^https?:\/\//i.test(decision.url)) {
          const preview = document.createElement("img");
          preview.src = decision.url;
          preview.alt = decision.alt || "文章图片预览";
          preview.loading = "lazy";
          row.append(preview);
        }
        const details = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = decision.alt || "文章图片";
        const description = document.createElement("span");
        description.textContent = (decision.recommendedRemove ? "建议移除" : "建议保留") + " · " + decision.description;
        details.append(title, description);
        const choice = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = decision.remove;
        checkbox.addEventListener("change", () => {
          decision.remove = checkbox.checked;
          markdown.value = applyImageDecisions(reviewedMarkdown, imageDecisions);
          renderImageDecisions();
        });
        choice.append(checkbox, "移除");
        row.append(details, choice);
        imageDecisionList.append(row);
      }
    };
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
        firecrawlKey: field("firecrawlKey").value.trim(),
        ...profile,
        activeProvider,
        modelProfiles: { ...modelProfiles },
        imageProvider: imageProvider.value as Settings["imageProvider"],
        imageReview: !!imageProvider.value,
        customPerspectives: customPerspectives.map(item => ({ ...item, sections: undefined })),
        targetDocumentId: target.value.trim(),
      };
    };
    const cloneSettings = (value: Settings): Settings => JSON.parse(JSON.stringify(value)) as Settings;
    const comparableSettings = ({ targetDocumentId: _targetDocumentId, ...config }: Settings): string => JSON.stringify(config);
    let setupBaseline: Settings | null = null;
    const saveSettings = async (): Promise<Settings> => {
      const next = readSettings();
      for (const perspective of next.customPerspectives) validatePerspective(perspective);
      const result = await this.saveData(STORAGE_NAME, next) as { code?: number; msg?: string };
      if (result?.code !== 0) throw new Error(result?.msg || "配置保存失败");
      this.settings = next;
      setupBaseline = cloneSettings(next);
      return next;
    };
    const run = async (label: string, stage: "scrape" | "review" | "save", operation: () => Promise<string>): Promise<void> => {
      busy = true;
      setStage(stage, "active");
      updateActions();
      setStatus(`${label}中…`);
      try {
        const message = await operation();
        setStage(stage, "done");
        if (stage === "scrape") setStage("review", "active");
        if (stage === "review") setStage("save", "active");
        if (stage === "save") setStage("review", "done");
        setStatus(message, "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`${label}未完成，请查看思源提示。`);
        showMessage(`${label}失败：${message}`, 7000, "error");
      } finally {
        busy = false;
        updateActions();
      }
    };

    // Styled listboxes synchronize through hidden inputs so both views share one setting.
    const setDropdown = (name: string, value: string, emitChange = true): void => {
      const control = field<HTMLInputElement>(name);
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
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      input.closest(".noosphere__secret")!.classList.toggle("is-revealed", visible);
      const label = `${visible ? "隐藏" : "显示"}密钥`;
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.setAttribute("aria-pressed", String(visible));
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
      if (id === "raw") return null;
      return REVIEW_PERSPECTIVES[id as keyof typeof REVIEW_PERSPECTIVES] || customPerspectives.find(item => item.id === id) || null;
    };
    const refreshPerspectiveEditor = (): void => {
      const perspective = activePerspective();
      const editable = !!perspective && customPerspectives.some(item => item.id === perspective.id);
      root.querySelector<HTMLElement>('[data-role="perspectiveMeta"]')!.hidden = !editable;
      action("deletePerspective").hidden = !editable;
      const editor = field<HTMLTextAreaElement>("perspectiveEditor");
      editor.disabled = busy;
      editor.readOnly = !editable;
      editor.value = perspective ? perspective.prompt : "原文模式直接使用抓取后的文章，不调用 AI。";
      const templateEditor = field<HTMLTextAreaElement>("templateEditor");
      templateEditor.disabled = busy;
      templateEditor.readOnly = !editable;
      templateEditor.value = perspective ? perspective.template : "原文模式直接保存抓取内容，不使用文章格式要求。";
      field<HTMLInputElement>("perspectiveLabel").value = editable ? perspective!.label : "";
      field<HTMLInputElement>("perspectiveDescription").value = editable ? perspective!.description : "";
      root.querySelector<HTMLElement>('[data-role="perspectivePrompt"]')!.hidden = perspectiveTab !== "prompt";
      root.querySelector<HTMLElement>('[data-role="templateBuilder"]')!.hidden = perspectiveTab !== "template";
      action("perspectiveTab").classList.toggle("is-active", perspectiveTab === "prompt");
      action("templateTab").classList.toggle("is-active", perspectiveTab === "template");
    };
    let displayedProvider: ProviderId = this.settings.activeProvider;
    const renderImageProviderOptions = (): void => {
      modelProfiles[displayedProvider] = currentProfile();
      const menu = root.querySelector<HTMLElement>('[data-dropdown="imageProvider"] .noosphere__dropdown-menu')!;
      menu.querySelectorAll('[data-dynamic-image="true"]').forEach(option => option.remove());
      for (const id of PROVIDER_ORDER) {
        if (!modelProfiles[id]?.modelVisionCapable) continue;
        const option = document.createElement("button");
        option.type = "button";
        option.setAttribute("role", "option");
        option.dataset.selectOption = "imageProvider";
        option.dataset.value = id;
        option.dataset.dynamicImage = "true";
        option.textContent = PROVIDER_PRESETS[id].label;
        menu.append(option);
      }
      if (imageProvider.value && !modelProfiles[imageProvider.value as ProviderId]?.modelVisionCapable) setDropdown("imageProvider", "");
      else setDropdown("imageProvider", imageProvider.value);
    };
    const renderProviderView = (): void => {
      const id = modelProvider.value as ProviderId;
      const preset = PROVIDER_PRESETS[id];
      const info = root.querySelector<HTMLElement>('[data-role="providerDescription"]')!;
      info.replaceChildren();
      const mark = document.createElement("span");
      mark.className = `noosphere__provider-mark noosphere__provider-mark--${id}`;
      mark.textContent = ({ kimi_api: "K", kimi_code: "C", volcengine: "火", minimax: "M", zhipu: "智", openai: "O", anthropic: "A", google: "G", custom: "+" } as Record<ProviderId, string>)[id];
      mark.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = preset.description;
      info.append(mark, text);
      if (preset.keyUrl) {
        const link = document.createElement("a");
        link.href = preset.keyUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "获取 API Key ↗";
        info.append(link);
      }
      root.querySelector<HTMLDetailsElement>('[data-role="providerAdvanced"]')!.open = id === "custom";
      modelResults.hidden = true;
      modelOptions.replaceChildren();
      renderImageProviderOptions();
    };
    /** Rebuild setup from the last saved settings without clearing the current article. */
    const restoreSetup = (saved: Settings): void => {
      customPerspectives = saved.customPerspectives.map(item => ({ ...item }));
      for (const id of PROVIDER_ORDER) delete modelProfiles[id];
      for (const id of PROVIDER_ORDER) {
        const profile = saved.modelProfiles[id];
        if (profile) modelProfiles[id] = { ...profile };
      }
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
      root.querySelectorAll<HTMLInputElement>(".noosphere__secret input").forEach(input => {
        input.type = "password";
        input.closest<HTMLElement>(".noosphere__secret")!.classList.remove("is-revealed");
        const reveal = root.querySelector<HTMLButtonElement>(`[data-reveal="${input.dataset.field}"]`)!;
        reveal.setAttribute("aria-label", "显示密钥");
        reveal.setAttribute("title", "显示密钥");
        reveal.setAttribute("aria-pressed", "false");
        syncSecretPreview(input);
      });
      updateActions();
    };
    modelProvider.addEventListener("change", () => {
      modelProfiles[displayedProvider] = currentProfile();
      displayedProvider = modelProvider.value as ProviderId;
      const next = modelProfiles[displayedProvider] || presetProfile(displayedProvider);
      setDropdown("modelFormat", next.modelFormat);
      field<HTMLInputElement>("modelBaseUrl").value = next.modelBaseUrl;
      const keyInput = field<HTMLInputElement>("modelKey");
      keyInput.type = "password";
      keyInput.closest(".noosphere__secret")!.classList.remove("is-revealed");
      const revealButton = root.querySelector<HTMLButtonElement>('[data-reveal="modelKey"]')!;
      revealButton.setAttribute("aria-label", "显示密钥");
      revealButton.setAttribute("title", "显示密钥");
      revealButton.setAttribute("aria-pressed", "false");
      keyInput.value = next.modelKey;
      syncSecretPreview(keyInput);
      field<HTMLInputElement>("modelName").value = next.modelName;
      modelVisionCapable.checked = next.modelVisionCapable;
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
      if (!current.value.trim()) current.value = PROVIDER_PRESETS[modelProvider.value as ProviderId].modelBaseUrl;
      modelResults.hidden = true;
      modelOptions.replaceChildren();
    });
    setupPerspective.addEventListener("change", () => { setDropdown("workPerspective", setupPerspective.value); action("deletePerspective").dataset.confirm = ""; action("deletePerspective").textContent = "删除视角"; refreshPerspectiveEditor(); updateActions(); });
    workPerspective.addEventListener("change", () => {
      setDropdown("reviewPerspective", workPerspective.value);
      if (workPerspective.value === "raw" && article) {
        markdown.value = article.markdown;
        setStatus("已切换到抓取原文，可以直接检查并保存。");
      }
      updateActions();
    });
    renderPerspectiveOptions();
    for (const [name, value] of [["modelFormat", this.settings.modelFormat], ["modelProvider", this.settings.activeProvider], ["reviewPerspective", this.settings.reviewPerspective], ["workPerspective", this.settings.reviewPerspective]]) setDropdown(name, value);
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
    inputUrl.addEventListener("input", () => { clearArticle(); setStatus("链接已更改，可以重新抓取。"); });
    markdown.addEventListener("input", () => {
      if (imageDecisions.length) {
        imageDecisions = [];
        reviewedMarkdown = "";
        imageDecisionPanel.hidden = true;
        imageDecisionList.replaceChildren();
      }
      updateActions();
    });
    target.addEventListener("input", updateActions);
    action("toggleSettings").addEventListener("click", () => {
      if (setup.hidden) {
        setupBaseline = cloneSettings(readSettings());
        showView("setup");
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
      void (async () => {
        try {
          if (!field("firecrawlKey").value.trim()) throw new Error("请填写 Firecrawl API Key");
          await saveSettings();
          showView("workbench");
          setStatus("配置就绪，粘贴文章链接开始抓取。", "success");
        } catch (error) {
          showMessage(`保存配置失败：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
        }
      })();
    });
    action("current").addEventListener("click", () => {
      if (activeDocumentId) { target.value = activeDocumentId; setStatus("已选择当前文档。", "success"); }
      else showMessage("没有找到当前打开的文档，请填写文档 ID。", 7000, "error");
      updateActions();
    });
    action("scrape").addEventListener("click", () => {
      clearArticle();
      void run("抓取", "scrape", async () => {
        const settings = await saveSettings();
        if (!settings.firecrawlKey) { showView("setup"); throw new Error("请先配置 Firecrawl API Key"); }
        article = await scrapeWithFirecrawl(inputUrl.value, settings.firecrawlKey);
        markdown.value = article.markdown;
        markdown.hidden = false;
        empty.hidden = true;
        meta.textContent = `${article.title} · ${new URL(article.url).hostname}`;
        return `已抓取「${article.title}」，可检查正文并保存。`;
      });
    });
    action("review").addEventListener("click", () => {
      void run("AI 审阅", "review", async () => {
        const settings = await saveSettings();
        if (!article || !markdown.value.trim()) throw new Error("请先抓取文章");
        if (!settings.modelKey || !settings.modelName) { showView("setup"); throw new Error("请先配置模型 API Key 和模型名称"); }
        const result = await reviewArticleDetailed(article, settings, markdown.value);
        article = result.article;
        reviewedMarkdown = result.markdown;
        imageDecisions = result.imageDecisions;
        markdown.value = applyImageDecisions(reviewedMarkdown, imageDecisions);
        renderImageDecisions();
        if (result.imageWarnings.length) showMessage(`图片识别有 ${result.imageWarnings.length} 项未完成，相关图片已保留。${result.imageWarnings[0]}`, 7000, "error");
        const enrichment = result.metadataAccepted.length ? "，补全了有原文证据的元数据" : "";
        return result.imagesReviewed ? `审阅完成${enrichment}；检查了 ${result.imagesReviewed} 张图片，请核对移除建议。` : `审阅完成${enrichment}，请检查正文。`;
      });
    });
    action("save").addEventListener("click", () => {
      void run("保存", "save", async () => {
        const settings = await saveSettings();
        if (!article || !markdown.value.trim()) throw new Error("请先抓取文章");
        await validateTargetDocument(settings.targetDocumentId);
        let content = markdown.value;
        let note = "";
        const result = await localizeMarkdownImages(content, article.url);
        content = result.markdown;
        markdown.value = content;
        note = `，已保存 ${result.localized} 张图片`;
        if (result.warnings.length) {
          note += `，${result.warnings.length} 张保留原链接`;
          showMessage(`${result.warnings.length} 张图片未能保存到思源，正文仍保留原链接。${result.warnings[0]}`, 7000, "error");
        }
        await appendArticle(settings.targetDocumentId, article, content);
        savedDocumentId = settings.targetDocumentId;
        saved.querySelector("span")!.textContent = `已保存 · ${savedDocumentId}`;
        saved.hidden = false;
        article = null;
        return `已保存到思源${note}。点击“打开文档”查看。`;
      });
    });
    action("openSaved").addEventListener("click", () => {
      if (!savedDocumentId) return;
      openTab({ app: this.app, doc: { id: savedDocumentId } });
      dialog.destroy();
    });
    setupBaseline = cloneSettings(readSettings());
    showView(this.settings.firecrawlKey ? "workbench" : "setup");
    updateActions();
  }
}

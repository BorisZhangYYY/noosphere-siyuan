/** SiYuan frontend plugin entry and capture workflow. */
import { Dialog, Plugin, getActiveEditor, showMessage } from "siyuan";
import { scrapeWithFirecrawl } from "./crawler/firecrawl";
import { reviewArticle } from "./review/provider";
import { localizeMarkdownImages } from "./images/localize";
import { appendArticle, validateTargetDocument } from "./siyuan/writer";
import { DEFAULT_SETTINGS, type Article, type Settings } from "./types";
import "./style.css";

const STORAGE_NAME = "settings.json";

export default class NoospherePlugin extends Plugin {
  private settings: Settings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    // Register the visible entry immediately, as other desktop plugins do.
    this.addTopBar({
      id: "noosphere-capture",
      icon: "iconLink",
      title: "知流 · 采集文章",
      position: "right",
      callback: () => this.openCaptureDialog(),
    });
    this.addCommand({
      langKey: "openNoosphereCapture",
      langText: "知流：采集网页文章",
      hotkey: "⌥⇧⌘N",
      callback: () => this.openCaptureDialog(),
    });
    const saved = await this.loadData(STORAGE_NAME) as Partial<Settings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  }

  private openCaptureDialog(): void {
    let article: Article | null = null;
    const activeDocumentId = getActiveEditor()?.protyle?.block?.rootID;
    const dialog = new Dialog({
      title: "知流 · 文章采集",
      width: "min(820px, 92vw)",
      content: `<div class="noosphere">
        <div class="noosphere__row"><label>文章链接<input data-field="url" class="b3-text-field" type="url" placeholder="https://example.com/article"></label></div>
        <div class="noosphere__row"><label>目标文档 ID<input data-field="targetDocumentId" class="b3-text-field" placeholder="20260930120000-abcdefg"></label><button data-action="current" class="b3-button b3-button--outline" type="button">使用当前文档</button></div>
        <div class="noosphere__actions"><button data-action="scrape" class="b3-button" type="button">1. 抓取预览</button><button data-action="review" class="b3-button b3-button--outline" type="button">2. AI 审阅</button><button data-action="save" class="b3-button b3-button--outline" type="button">3. 写入文档</button></div>
        <label>正文预览与编辑<textarea data-field="markdown" class="b3-text-field" rows="15" placeholder="抓取后可在此检查或手动修改正文"></textarea></label>
        <p class="noosphere__status" data-role="status" aria-live="polite">填写文章链接后开始抓取。</p>
        <details class="noosphere__settings"><summary>服务配置</summary>
          <label>Firecrawl API Key<input data-field="firecrawlKey" class="b3-text-field" type="password" autocomplete="off"></label>
          <label>模型 API 地址<input data-field="modelBaseUrl" class="b3-text-field" type="url" placeholder="https://api.openai.com/v1"></label>
          <label>模型 API Key<input data-field="modelKey" class="b3-text-field" type="password" autocomplete="off"></label>
          <label>模型名称<input data-field="modelName" class="b3-text-field" placeholder="例如 gpt-4.1-mini"></label>
          <label>模型接口格式<select data-field="modelFormat" class="b3-select"><option value="openai_chat">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option></select></label>
          <label>Anthropic API 版本<input data-field="anthropicVersion" class="b3-text-field" placeholder="2023-06-01"></label>
          <label>审阅指令<textarea data-field="reviewPrompt" class="b3-text-field" rows="4"></textarea></label>
          <label class="noosphere__check"><input data-field="localizeImages" type="checkbox">写入前将图片保存到思源</label>
          <button data-action="settings" class="b3-button b3-button--outline" type="button">保存配置</button>
        </details>
      </div>`,
    });
    const root = dialog.element.querySelector<HTMLElement>(".noosphere");
    if (!root) return;
    const field = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(name: string): T => {
      const element = root.querySelector<T>(`[data-field="${name}"]`);
      if (!element) throw new Error(`缺少输入项：${name}`);
      return element;
    };
    const status = root.querySelector<HTMLElement>("[data-role=status]")!;
    const markdown = field<HTMLTextAreaElement>("markdown");
    const inputUrl = field<HTMLInputElement>("url");
    const target = field<HTMLInputElement>("targetDocumentId");
    target.value = this.settings.targetDocumentId;
    for (const name of ["firecrawlKey", "modelBaseUrl", "modelKey", "modelName", "anthropicVersion", "reviewPrompt"] as const) {
      field(name).value = this.settings[name];
    }
    field<HTMLSelectElement>("modelFormat").value = this.settings.modelFormat;
    field<HTMLInputElement>("localizeImages").checked = this.settings.localizeImages;
    inputUrl.addEventListener("input", () => { article = null; markdown.value = ""; });

    const readSettings = (): Settings => ({
      firecrawlKey: field("firecrawlKey").value,
      modelBaseUrl: field("modelBaseUrl").value,
      modelKey: field("modelKey").value,
      modelName: field("modelName").value,
      modelFormat: field<HTMLSelectElement>("modelFormat").value as Settings["modelFormat"],
      anthropicVersion: field("anthropicVersion").value,
      reviewPrompt: field("reviewPrompt").value,
      localizeImages: field<HTMLInputElement>("localizeImages").checked,
      targetDocumentId: target.value,
    });
    const saveSettings = async (): Promise<Settings> => {
      this.settings = readSettings();
      await this.saveData(STORAGE_NAME, this.settings);
      return this.settings;
    };
    const run = async (label: string, action: () => Promise<string>): Promise<void> => {
      const buttons = root.querySelectorAll<HTMLButtonElement>("button");
      buttons.forEach(button => { button.disabled = true; });
      status.textContent = `${label}中…`;
      try {
        status.textContent = await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.textContent = `${label}失败：${message}`;
        showMessage(status.textContent, 7000, "error");
      } finally {
        buttons.forEach(button => { button.disabled = false; });
      }
    };

    root.querySelector("[data-action=current]")?.addEventListener("click", () => {
      if (activeDocumentId) target.value = activeDocumentId;
      else status.textContent = "没有找到当前打开的文档，请手动填写文档 ID。";
    });
    root.querySelector("[data-action=settings]")?.addEventListener("click", () => {
      void run("保存配置", async () => { await saveSettings(); return "配置已保存到当前思源工作空间。"; });
    });
    root.querySelector("[data-action=scrape]")?.addEventListener("click", () => {
      void run("抓取", async () => {
        const settings = await saveSettings();
        article = null;
        article = await scrapeWithFirecrawl(inputUrl.value, settings.firecrawlKey);
        markdown.value = article.markdown;
        return `已抓取「${article.title}」，请检查正文后再写入。`;
      });
    });
    root.querySelector("[data-action=review]")?.addEventListener("click", () => {
      void run("AI 审阅", async () => {
        const settings = await saveSettings();
        if (!article || !markdown.value.trim()) throw new Error("请先抓取文章");
        markdown.value = await reviewArticle({ ...article, markdown: markdown.value }, settings);
        return "AI 审阅完成，请检查修改后的正文。";
      });
    });
    root.querySelector("[data-action=save]")?.addEventListener("click", () => {
      void run("写入", async () => {
        const settings = await saveSettings();
        if (!article || !markdown.value.trim()) throw new Error("请先抓取文章");
        await validateTargetDocument(settings.targetDocumentId);
        let content = markdown.value;
        let note = "";
        if (settings.localizeImages) {
          const result = await localizeMarkdownImages(content, article.url);
          content = result.markdown;
          markdown.value = content;
          note = `，已本地化 ${result.localized} 张图片`;
          if (result.warnings.length) note += `；${result.warnings.length} 张图片保留原链接`;
        }
        const blockId = await appendArticle(settings.targetDocumentId, article, content);
        article = null;
        return `已写入文档，首个块 ID：${blockId}${note}。再次写入请重新抓取。`;
      });
    });
  }
}

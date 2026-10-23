/** 在知流弹窗使用思源原生轻量编辑器；编辑事务只在前端执行，不创建笔记文档。 */
import { Menu, Protyle, ProtyleMethod, type App, type Lute, type IOperation } from "siyuan";
import DOMPurify from "dompurify";
import type { Article } from "../types";
import type { ArticleEditorState } from "./draft";
import { composeArticle, sourceMetadata, stripSourceMetadata } from "./compose";
import { localAssetPath } from "../images/reference";
import type { ImageDecision } from "../review/images";
import { previewUrl, type MarkdownRenderer } from "./preview";

const METADATA = "data-noosphere-metadata";

/** 素材拖放与光标插入共用安全图片 HTML，地址沿用原图而非缩略图。 */
export function articleImageHTML(image: Pick<ImageDecision, "url" | "alt">, articleUrl: string): string | undefined {
  const url = previewUrl(image.url, articleUrl, true);
  if (!url) return undefined;
  const element = document.createElement("img");
  element.src = url; element.alt = image.alt; element.referrerPolicy = "no-referrer";
  return element.outerHTML;
}
const BLOCKS = [
  ["一级标题", "heading h1", "# \u200b"], ["二级标题", "heading h2", "## \u200b"],
  ["三级标题", "heading h3", "### \u200b"], ["四级标题", "heading h4", "#### \u200b"],
  ["五级标题", "heading h5", "##### \u200b"], ["六级标题", "heading h6", "###### \u200b"],
  ["无序列表", "unordered bullet list", "- \u200b"], ["有序列表", "ordered numbered list", "1. \u200b"],
  ["任务列表", "task checkbox todo", "- [ ] \u200b"], ["引用", "quote blockquote", "> \u200b"],
  ["代码块", "code", "```\n\u200b\n```"], ["表格", "table", "| 列 1 | 列 2 |\n| --- | --- |\n| \u200b |  |"],
  ["分隔线", "divider horizontal rule", "---"], ["数学公式", "math equation", "$$\n\u200b\n$$"],
] as const;

/** 原生块 DOM 保留格式属性，拒绝脚本、事件处理器和网页嵌入。 */
export function sanitizeBlockDOM(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true },
    ADD_ATTR: ["contenteditable", "spellcheck", "updated", "fold"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"], FORBID_ATTR: ["srcset"] });
}

/** 来源作为系统管理的独立块插入；编辑和再次导入不会重复增加来源。 */
export function composeBlockDOM(article: Article, blockDOM: string, lute: Pick<Lute, "Md2BlockDOM">): string {
  const container = document.createElement("div");
  container.innerHTML = sanitizeBlockDOM(blockDOM);
  container.querySelectorAll(`[${METADATA}]`).forEach(node => node.remove());
  const metadata = document.createElement("div");
  metadata.innerHTML = sanitizeBlockDOM(lute.Md2BlockDOM(sourceMetadata(article)));
  for (const node of Array.from(metadata.children)) node.setAttribute(METADATA, "true");
  const heading = container.firstElementChild;
  const next = heading?.getAttribute("data-type") === "NodeHeading" ? heading.nextSibling : container.firstChild;
  for (const node of Array.from(metadata.children)) container.insertBefore(node, next);
  return container.innerHTML;
}

/** 图片本地化后同步原生结构中的图片地址，保留文字颜色、块属性和引用。 */
export function localizeEditorState(state: ArticleEditorState, markdown: string, assets: Record<string, string>): ArticleEditorState {
  const updateDOM = (html: string): string => {
    const container = document.createElement("div"); container.innerHTML = sanitizeBlockDOM(html);
    for (const img of Array.from(container.querySelectorAll<HTMLImageElement>("img"))) {
      const raw = img.getAttribute("src") || "";
      const local = assets[raw] || assets[raw.replace(/^\//, "")];
      if (!local) continue;
      img.setAttribute("src", local);
      img.removeAttribute("data-src");
      const wrapper = img.closest<HTMLElement>('[data-type="img"]');
      wrapper?.querySelectorAll<HTMLElement>('[data-src]').forEach(node => node.setAttribute("data-src", local));
    }
    return container.innerHTML;
  };
  return { ...state, markdown, blockDOM: updateDOM(state.blockDOM),
    ...(state.fullBlockDOM ? { fullBlockDOM: updateDOM(state.fullBlockDOM) } : {}) };
}

/** 素材移除与恢复保留原生文字格式，不通过 Markdown 重建整篇文章。 */
export function applyEditorImageChoices(state: ArticleEditorState, markdown: string, decisions: ImageDecision[]): ArticleEditorState {
  const fullBlockDOM = state.fullBlockDOM || state.blockDOM;
  const container = document.createElement("div"); container.innerHTML = sanitizeBlockDOM(fullBlockDOM);
  container.querySelectorAll<HTMLImageElement>("img[src]").forEach(img => {
    const src = img.getAttribute("src");
    if (decisions.some(item => item.remove && [item.url, item.previewUrl].includes(src || ""))) {
      (img.closest('[data-type="img"]') || img).remove();
    }
  });
  return { ...state, markdown, blockDOM: container.innerHTML, fullBlockDOM };
}

export class NativeArticleEditor {
  private readonly editor: Protyle;
  private readonly content: HTMLElement;
  private readonly observer: MutationObserver;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readOnly = false;
  private lastContent = "";
  private article: Article;
  private readonly host: HTMLElement;
  private insertionRange: Range | undefined;

  constructor(app: App, host: HTMLElement, article: Article, markdown: string,
    state: ArticleEditorState | undefined, private readonly onChange: (state: ArticleEditorState, title: string) => void) {
    this.article = article;
    this.host = host;
    this.editor = new Protyle(app, host, {
      lite: true, blockId: "", render: { title: false, background: false, breadcrumb: false, gutter: true, scroll: false },
      hint: { extend: [{ key: "/", hint: (query, protyle) => {
        const value = query.toLocaleLowerCase().trim();
        const suggestions = BLOCKS.filter(([name, keywords]) => `${name} ${keywords}`.includes(value)).map(([name, , sample]) => ({
          value: protyle.lute!.Md2BlockDOM(sample), html: `<div class="b3-list-item__first"><span class="b3-list-item__text">${name}</span></div>`,
        }));
        protyle.hint!.genHTML(suggestions, protyle, false, "hint");
        return [];
      } }] },
    });
    const protyle = this.editor.protyle;
    this.content = protyle.wysiwyg!.element;
    const body = state?.markdown === markdown ? state.blockDOM : protyle.lute!.Md2BlockDOM(stripSourceMetadata(composeArticle(article, markdown)));
    this.content.innerHTML = composeBlockDOM(article, body, protyle.lute!);
    this.normalizeLinks();
    this.normalizeImages(); this.lockMetadata();
    this.lastContent = this.snapshot().nativeMarkdown;
    this.observer = new MutationObserver(() => {
      if (this.disposed || this.readOnly) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.emit(), 80);
    });
    this.observer.observe(this.content, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["style", "src", "data-type", "data-subtype", "fold", "checked"] });
    this.content.addEventListener("beforeinput", this.protectMetadata, true);
    this.content.addEventListener("drop", this.moveLocalBlocks, true);
    document.addEventListener("selectionchange", this.rememberInsertionRange);
    this.content.addEventListener("pointerup", this.rememberInsertionRange);
    this.content.addEventListener("keyup", this.rememberInsertionRange);
    host.addEventListener("click", this.openBlockMenu, true);
    this.renderBlocks(); this.setReadOnly(true);
  }

  /** 保留原生撤销、格式与引用；只读时禁止输入和素材变更。 */
  setReadOnly(readOnly: boolean): void {
    if (this.readOnly === readOnly) return;
    this.readOnly = readOnly;
    if (readOnly) this.insertionRange = undefined;
    if (readOnly) this.editor.disable(); else this.editor.enable();
    this.content.setAttribute("data-readonly", String(readOnly));
    this.lockMetadata();
  }

  setArticle(article: Article): void {
    if (JSON.stringify(this.article) === JSON.stringify(article)) return;
    this.article = article;
    if (this.readOnly) {
      const metadata = document.createElement("div");
      metadata.innerHTML = composeBlockDOM(article, "", this.editor.protyle.lute!);
      const previous = this.content.querySelector(`[${METADATA}]`);
      const next = previous?.nextSibling || this.content.firstElementChild?.nextSibling || null;
      this.content.querySelectorAll(`[${METADATA}]`).forEach(node => node.remove());
      for (const node of Array.from(metadata.children)) this.content.insertBefore(node, next);
      this.lockMetadata();
    }
  }

  focus(): void {
    this.content.focus({ preventScroll: true });
  }

  /** 使用离开正文前的真实选区和宿主插入事务；无有效光标时不回退到文末。 */
  insertImage(image: Pick<ImageDecision, "url" | "alt">): boolean {
    if (this.readOnly || this.disposed) return false;
    this.rememberInsertionRange();
    const range = this.insertionRange?.cloneRange();
    const html = articleImageHTML(image, this.article.url);
    if (!range || !html || !this.editableRange(range)) return false;
    range.collapse(false);
    this.editor.protyle.toolbar!.range = range;
    this.editor.insert(this.editor.protyle.lute!.HTML2BlockDOM(html), false, true);
    this.normalizeImages(); this.lockMetadata(); this.emit();
    this.rememberInsertionRange();
    return true;
  }

  /** 流式正文也使用当前思源编辑器的 Lute 配置和块排版。 */
  markdownRenderer(): MarkdownRenderer {
    const lute = this.editor.protyle.lute!;
    return { native: true, ProtylePreviewStr: (_name, markdown) => lute.Md2BlockDOM(markdown) };
  }

  isUploading(): boolean { return this.editor.isUploading(); }

  /** 确定、关闭和切换文章前同步读取 DOM，包含尚未触发防抖的最后一次输入。 */
  snapshot(): ArticleEditorState {
    const wysiwyg = this.editor.protyle.wysiwyg as typeof this.editor.protyle.wysiwyg & { flushPendingInput?: () => void };
    wysiwyg.flushPendingInput?.();
    const blockDOM = this.bodyDOM();
    const lute = this.editor.protyle.lute!;
    return { markdown: composeArticle(this.article, lute.BlockDOM2StdMd(blockDOM)),
      nativeMarkdown: lute.BlockDOM2Md(blockDOM), blockDOM };
  }

  flush(): void { this.emit(); }

  destroy(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.observer.disconnect(); this.content.removeEventListener("beforeinput", this.protectMetadata, true);
    this.content.removeEventListener("drop", this.moveLocalBlocks, true);
    document.removeEventListener("selectionchange", this.rememberInsertionRange);
    this.content.removeEventListener("pointerup", this.rememberInsertionRange);
    this.content.removeEventListener("keyup", this.rememberInsertionRange);
    this.host.removeEventListener("click", this.openBlockMenu, true);
    this.editor.destroy();
  }

  private bodyDOM(): string {
    const container = this.content.cloneNode(true) as HTMLElement;
    container.querySelectorAll(`[${METADATA}]`).forEach(node => node.remove());
    container.querySelectorAll("[contenteditable][spellcheck]").forEach(node => node.setAttribute("contenteditable", "true"));
    container.querySelectorAll(".protyle-wysiwyg--select").forEach(node => node.classList.remove("protyle-wysiwyg--select"));
    container.querySelectorAll("wbr").forEach(node => node.remove());
    container.querySelectorAll('[data-type="NodeBlockQueryEmbed"]').forEach(node => {
      node.removeAttribute("data-render");
      node.querySelectorAll(".protyle-wysiwyg__embed").forEach(child => child.remove());
    });
    return sanitizeBlockDOM(container.innerHTML);
  }

  private emit(): void {
    if (this.disposed || this.readOnly) return;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const state = this.snapshot();
    if (state.nativeMarkdown === this.lastContent) return;
    this.lastContent = state.nativeMarkdown;
    const title = state.markdown.match(/^#{1,6}\s+([^\n]+)/)?.[1] || this.article.title;
    this.onChange(state, title.replace(/\u200b/g, "").trim());
  }

  private lockMetadata(): void {
    for (const block of Array.from(this.content.querySelectorAll<HTMLElement>(`[${METADATA}]`))) {
      block.setAttribute("data-readonly", "true");
      block.querySelectorAll("[contenteditable]").forEach(node => node.setAttribute("contenteditable", "false"));
    }
  }

  private editableRange(range: Range): boolean {
    return this.content.contains(range.startContainer) && this.content.contains(range.endContainer)
      && !Array.from(this.content.querySelectorAll(`[${METADATA}]`)).some(node => range.intersectsNode(node));
  }

  /** 点击素材面板会改变浏览器焦点，但不能覆盖最后一次正文光标位置。 */
  private readonly rememberInsertionRange = (): void => {
    if (this.readOnly || this.disposed) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (this.editableRange(range)) this.insertionRange = range.cloneRange();
    else if (this.content.contains(range.startContainer)) this.insertionRange = undefined;
  };

  private readonly protectMetadata = (event: Event): void => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    for (const node of Array.from(this.content.querySelectorAll(`[${METADATA}]`))) {
      if (range.intersectsNode(node)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    }
  };

  private normalizeImages(): void {
    for (const img of Array.from(this.content.querySelectorAll<HTMLImageElement>("img[src]"))) {
      const raw = img.getAttribute("src") || "";
      const url = localAssetPath(raw) || previewUrl(raw, this.article.url, true);
      if (url) img.src = url;
      else img.removeAttribute("src");
      img.referrerPolicy = "no-referrer";
    }
  }

  /** 原生链接也按文章来源解析，不把网页相对地址拼到思源内核地址。 */
  private normalizeLinks(): void {
    this.content.querySelectorAll<HTMLElement>('a[href], [data-type~="a"][data-href]').forEach(node => {
      const attribute = node.tagName === "A" ? "href" : "data-href";
      const url = previewUrl(node.getAttribute(attribute) || "", this.article.url);
      if (url) node.setAttribute(attribute, url); else node.removeAttribute(attribute);
    });
  }

  /** 同一篇临时文章内拖动块使用移动语义；外部块仍由原生轻量模式安全复制。 */
  private readonly moveLocalBlocks = (event: DragEvent): void => {
    const runtime = (window as unknown as { siyuan?: { dragElement?: HTMLElement } }).siyuan;
    if (this.readOnly || event.ctrlKey || event.altKey || event.shiftKey || runtime?.dragElement !== this.content) return;
    const target = this.content.querySelector<HTMLElement>('[class*="dragover__top--sibling"], [class*="dragover__bottom--sibling"]');
    if (!target || target.hasAttribute(METADATA)) return;
    const selected = Array.from(this.content.querySelectorAll<HTMLElement>(".protyle-wysiwyg--select"))
      .filter(node => node.parentElement === target.parentElement && !node.hasAttribute(METADATA));
    if (!selected.length || selected.some(node => node === target || node.contains(target))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const parentID = target.parentElement === this.content ? this.editor.protyle.block.parentID : target.parentElement?.dataset.nodeId;
    const undo: IOperation[] = selected.map(node => ({ action: "move", id: node.dataset.nodeId!, parentID,
      previousID: node.previousElementSibling?.getAttribute("data-node-id") || undefined }));
    const before = target.className.includes("dragover__top--sibling");
    const next = before ? target : target.nextSibling;
    for (const node of selected) target.parentElement!.insertBefore(node, next);
    const operations: IOperation[] = selected.map(node => ({ action: "move", id: node.dataset.nodeId!, parentID,
      previousID: node.previousElementSibling?.getAttribute("data-node-id") || undefined }));
    this.editor.transaction(operations, undo);
    this.content.querySelectorAll<HTMLElement>('[class*="dragover__"]').forEach(node => {
      node.className = node.className.split(" ").filter(name => !name.startsWith("dragover__")).join(" ");
    });
    this.emit();
  };

  /** 临时块没有内核记录，块标菜单只使用宿主的本地格式转换和撤销能力。 */
  private readonly openBlockMenu = (event: MouseEvent): void => {
    const button = (event.target as Element).closest<HTMLElement>(".protyle-gutters button[data-node-id]");
    if (!button || button.dataset.type === "fold" || button.dataset.type?.startsWith("gutter")) return;
    const block = Array.from(this.content.querySelectorAll<HTMLElement>("[data-node-id]"))
      .find(node => node.dataset.nodeId === button.dataset.nodeId);
    if (!block || block.hasAttribute(METADATA)) { event.stopImmediatePropagation(); return; }
    event.preventDefault(); event.stopImmediatePropagation();
    if (this.readOnly) return;
    this.content.querySelectorAll(".protyle-wysiwyg--select").forEach(node => node.classList.remove("protyle-wysiwyg--select"));
    this.editor.focusBlock(block);
    const menu = new Menu("noosphere-native-block");
    menu.addItem({ label: "段落", click: () => this.editor.turnIntoTransaction(block, "Blocks2Ps") });
    menu.addItem({ label: "标题", submenu: [1, 2, 3, 4, 5, 6].map(level => ({ label: `${level} 级标题`,
      click: () => this.editor.turnIntoTransaction(block, "Blocks2Hs", level) })) });
    for (const [label, type] of [["无序列表", "Blocks2ULs"], ["有序列表", "Blocks2OLs"], ["任务列表", "Blocks2TLs"], ["引用", "Blocks2Blockquote"]] as const) {
      menu.addItem({ label, click: () => this.editor.turnIntoOneTransaction([block], type) });
    }
    menu.addItem({ type: "separator" });
    menu.addItem({ label: "删除", icon: "iconTrashcan", click: () => {
      const id = block.dataset.nodeId!;
      const previousID = block.previousElementSibling?.getAttribute("data-node-id") || undefined;
      const parentID = block.parentElement === this.content ? this.editor.protyle.block.parentID : block.parentElement?.dataset.nodeId;
      const html = block.outerHTML; block.remove();
      this.editor.transaction([{ action: "delete", id }], [{ action: "insert", id, previousID, parentID, data: html }]);
      this.emit();
    } });
    const bounds = button.getBoundingClientRect(); menu.open({ x: bounds.left, y: bounds.bottom });
  };

  /** 初始内容复用宿主渲染器，之后的输入由 Protyle 自己更新。 */
  private renderBlocks(): void {
    for (const method of ["highlightRender", "mathRender", "mermaidRender", "graphvizRender", "flowchartRender", "chartRender", "abcRender", "plantumlRender"] as const) {
      ProtyleMethod?.[method]?.(this.content);
    }
  }
}

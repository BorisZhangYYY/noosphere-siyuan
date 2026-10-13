/** 复用思源 Lute 渲染 Markdown，保留原稿并安全显示网页图片及链接。 */
import DOMPurify from "dompurify";
import type { Lute } from "siyuan";
import { localAssetPath, stripArticleImagePlaceholders } from "../images/reference";
import { composeArticle } from "./compose";
import type { Article } from "../types";

export type MarkdownRenderer = Pick<Lute, "ProtylePreviewStr">;

/** 相对路径以文章为基准，思源本地资源始终由当前工作空间提供。 */
export function previewUrl(raw: string, articleUrl: string, image = false): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("#") && !image) return value;
  const local = localAssetPath(value);
  if (local) return new URL(local, window.location.origin).href;
  try {
    const url = new URL(value, articleUrl);
    if (["http:", "https:"].includes(url.protocol) || (!image && url.protocol === "mailto:")) return url.href;
  } catch { /* 不支持的路径按缺失资源处理。 */ }
  return null;
}

/** 外部正文只允许排版内容；过滤脚本、内嵌页面及事件处理器。 */
export function renderArticlePreview(element: HTMLElement, markdown: string, articleUrl: string, renderer: MarkdownRenderer, preserveNodes = false): void {
  const content = preserveNodes ? document.createElement("div") : element;
  content.innerHTML = DOMPurify.sanitize(renderer.ProtylePreviewStr("noosphere-article", stripArticleImagePlaceholders(markdown, articleUrl)), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "video", "audio"],
    FORBID_ATTR: ["style", "srcset"],
  });
  content.querySelectorAll<HTMLAnchorElement>("a[href]").forEach(link => {
    const url = previewUrl(link.getAttribute("href") || "", articleUrl);
    if (!url) { link.removeAttribute("href"); return; }
    link.href = url;
    if (!url.startsWith("#")) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
  });
  content.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.disabled = true; });
  content.querySelectorAll<HTMLImageElement>("img").forEach(img => {
    // 一些抓取服务返回懒加载图片；优先读取实际图片地址。
    const raw = img.getAttribute("data-src") || img.getAttribute("src") || "";
    const url = previewUrl(raw, articleUrl, true);
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    img.decoding = "async";
    const showFallback = (): void => {
      const fallback = document.createElement("span");
      fallback.className = "noosphere__image-fallback";
      fallback.dataset.imageUrl = url || raw;
      fallback.textContent = img.alt || "图片暂时无法加载";
      img.replaceWith(fallback);
    };
    img.addEventListener("error", showFallback, { once: true });
    if (url) img.src = url;
    else showFallback();
  });
  if (preserveNodes) reconcilePreview(element, content);
}

/** 增量预览保留相同的段落、链接和图片节点，避免每次吐字都重新加载图片或改变滚动锚点。 */
function reconcilePreview(element: Node, content: Node): void {
  const nextChildren = Array.from(content.childNodes);
  for (const [index, next] of nextChildren.entries()) {
    const current = element.childNodes[index];
    if (!current) { element.appendChild(next); continue; }
    if (current.isEqualNode(next)) continue;
    if (current.nodeType === Node.TEXT_NODE && next.nodeType === Node.TEXT_NODE) { current.nodeValue = next.nodeValue; continue; }
    if (current instanceof HTMLElement && next instanceof HTMLElement) {
      if (current.classList.contains("noosphere__image-fallback") && next instanceof HTMLImageElement && current.dataset.imageUrl === next.src) continue;
      if (current.tagName === next.tagName) {
        for (const name of current.getAttributeNames()) if (!next.hasAttribute(name)) current.removeAttribute(name);
        for (const attribute of Array.from(next.attributes)) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
        reconcilePreview(current, next);
        continue;
      }
    }
    element.replaceChild(next, current);
  }
  while (element.childNodes.length > nextChildren.length) element.removeChild(element.lastChild!);
}

const textSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const atomicPreviewTags = new Set(["IMG", "HR", "BR", "INPUT"]);

type RevealSlot = { path: number[]; start: number; end: number } & (
  { kind: "text"; units: string[] } | { kind: "element"; originallyHidden: boolean }
);
interface PreparedBody { markdown: string; url: string; content: HTMLElement; slots: RevealSlot[]; text: string }
const preparedBodies = new WeakMap<MarkdownRenderer, PreparedBody>();

/** 未闭合的链接不显示地址，未闭合的加粗先补齐排版；代码块保留原样。 */
function streamingMarkdown(markdown: string): string {
  if ((markdown.match(/^\s*(?:```|~~~)/gm)?.length || 0) % 2) return markdown;
  let text = markdown.replace(/(!?)\[([^\]\n]*)\]\([^\)\n]*$/, (_match, image: string, label: string) => image ? "" : label);
  const boundary = text.lastIndexOf("\n\n");
  const paragraph = boundary < 0 ? text : text.slice(boundary + 2);
  if ((paragraph.match(/(?<!\\)\*\*(?!\*)/g)?.length || 0) % 2) text += "**";
  return text;
}

/** 同一批正文只做一次 Lute 排版、净化和字素分段；动画帧直接更新已存在的文字节点。 */
function prepareBody(markdown: string, url: string, renderer: MarkdownRenderer): PreparedBody {
  const cached = preparedBodies.get(renderer);
  if (cached?.markdown === markdown && cached.url === url) return cached;
  const content = document.createElement("div");
  renderArticlePreview(content, streamingMarkdown(markdown), url, renderer);
  const slots: RevealSlot[] = []; let text = "", offset = 0;
  const visit = (node: Node, path: number[]): void => {
    const start = offset;
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue || "";
      const units = Array.from(textSegmenter.segment(value), part => part.segment);
      offset += units.length; text += value;
      slots.push({ kind: "text", path, start, end: offset, units });
    } else {
      const index = slots.length;
      if (node instanceof HTMLElement) slots.push({ kind: "element", path, start, end: start, originallyHidden: node.hidden });
      if (node instanceof HTMLElement && atomicPreviewTags.has(node.tagName)) { offset++; text += "\uFFFC"; }
      else Array.from(node.childNodes).forEach((child, i) => visit(child, [...path, i]));
      if (node instanceof HTMLElement) slots[index].end = offset;
    }
  };
  Array.from(content.childNodes).forEach((node, i) => visit(node, [i]));
  const prepared = { markdown, url, content, slots, text };
  preparedBodies.set(renderer, prepared); return prepared;
}

function slotNode(root: Node, path: number[]): Node {
  return path.reduce((node, index) => node.childNodes[index], root);
}

/** 隐藏尚未显示的段落和图片，已显示的节点仅改文字，不重新排版整篇文章。 */
function revealSlots(slots: Array<{ slot: RevealSlot; node: Node; shown?: number }>, count: number): void {
  for (const entry of slots) {
    const { slot, node } = entry;
    if (slot.kind === "text") {
      const shown = Math.max(0, Math.min(slot.units.length, count - slot.start));
      if (entry.shown === shown) continue;
      entry.shown = shown;
      const text = slot.units.slice(0, shown).join("");
      if (node.nodeValue !== text) node.nodeValue = text;
    } else if (node instanceof HTMLElement) {
      const hidden = slot.originallyHidden || count <= slot.start || slot.end === slot.start;
      if (node.hidden !== hidden) node.hidden = hidden;
    }
  }
}

interface StreamScene {
  prefix: HTMLElement; body: HTMLElement; prefixMarkdown: string; prepared?: PreparedBody;
  slots: Array<{ slot: RevealSlot; node: Node }>;
  imageSizes: Map<string, { width: number; height: number }>;
  boundImages: WeakSet<HTMLImageElement>;
}
const streamScenes = new WeakMap<HTMLElement, StreamScene>();

export function reviewPreviewText(markdown: string, articleUrl: string, renderer: MarkdownRenderer): string {
  return prepareBody(markdown, articleUrl, renderer).text;
}

/** 每批内容更新排版一次；每帧沿用段落、链接和图片节点，避免长文反复净化、测量和加载图片。 */
export function renderStreamingArticlePreview(element: HTMLElement, article: Article, title: string, markdown: string, renderer: MarkdownRenderer, count: number): void {
  let scene = streamScenes.get(element);
  if (!scene || scene.body.parentNode !== element) {
    const imageSizes = new Map<string, { width: number; height: number }>();
    element.querySelectorAll<HTMLImageElement>("img").forEach(image => {
      if (image.naturalWidth && image.naturalHeight) imageSizes.set(image.src, { width: image.naturalWidth, height: image.naturalHeight });
    });
    const prefix = document.createElement("div"), body = document.createElement("div");
    prefix.className = "noosphere__stream-prefix"; body.className = "noosphere__stream-body";
    element.replaceChildren(prefix, body);
    scene = { prefix, body, imageSizes, boundImages: new WeakSet(), prefixMarkdown: "", slots: [] }; streamScenes.set(element, scene);
  }
  const prefixMarkdown = composeArticle(article, `# ${title}\n\n\u200b`);
  if (scene.prefixMarkdown !== prefixMarkdown) {
    renderArticlePreview(scene.prefix, prefixMarkdown, article.url, renderer, true);
    scene.prefix.querySelectorAll("*").forEach(node => { if (node.textContent === "\u200b") node.remove(); });
    scene.prefixMarkdown = prefixMarkdown;
  }
  const prepared = prepareBody(markdown, article.url, renderer);
  if (scene.prepared !== prepared) {
    const next = prepared.content.cloneNode(true) as HTMLElement;
    const masked = prepared.slots.map(slot => ({ slot, node: slotNode(next, slot.path) }));
    revealSlots(masked, count);
    reconcilePreview(scene.body, next);
    scene.slots = prepared.slots.map(slot => ({ slot, node: slotNode(scene!.body, slot.path) }));
    scene.prepared = prepared;
    // 已加载的原图保留宽高比例，后续图片加载时不再突然撑开正文。
    scene.body.querySelectorAll<HTMLImageElement>("img").forEach(image => {
      const size = scene!.imageSizes.get(image.src);
      if (size) { image.width = size.width; image.height = size.height; }
      if (scene!.boundImages.has(image)) return;
      scene!.boundImages.add(image);
      image.addEventListener("error", () => {
        const fallback = document.createElement("span");
        fallback.className = "noosphere__image-fallback"; fallback.dataset.imageUrl = image.src;
        fallback.textContent = image.alt || "图片暂时无法加载"; fallback.hidden = image.hidden;
        image.replaceWith(fallback);
        for (const entry of scene!.slots) if (entry.node === image) entry.node = fallback;
      }, { once: true });
      image.addEventListener("load", () => {
        if (image.naturalWidth && image.naturalHeight) scene!.imageSizes.set(image.src, { width: image.naturalWidth, height: image.naturalHeight });
      }, { once: true });
    });
  }
  revealSlots(scene.slots, count);
}

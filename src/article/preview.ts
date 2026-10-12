/** 复用思源 Lute 渲染 Markdown，保留原稿并安全显示网页图片及链接。 */
import DOMPurify from "dompurify";
import type { Lute } from "siyuan";
import { localAssetPath } from "../images/reference";

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
export function renderArticlePreview(element: HTMLElement, markdown: string, articleUrl: string, renderer: MarkdownRenderer): void {
  element.innerHTML = DOMPurify.sanitize(renderer.ProtylePreviewStr("noosphere-article", markdown), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "video", "audio"],
    FORBID_ATTR: ["style", "srcset"],
  });
  element.querySelectorAll<HTMLAnchorElement>("a[href]").forEach(link => {
    const url = previewUrl(link.getAttribute("href") || "", articleUrl);
    if (!url) { link.removeAttribute("href"); return; }
    link.href = url;
    if (!url.startsWith("#")) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
  });
  element.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.disabled = true; });
  element.querySelectorAll<HTMLImageElement>("img").forEach(img => {
    // 一些抓取服务返回懒加载图片；优先读取实际图片地址。
    const raw = img.getAttribute("data-src") || img.getAttribute("src") || "";
    const url = previewUrl(raw, articleUrl, true);
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    img.decoding = "async";
    const showFallback = (): void => {
      const fallback = document.createElement("span");
      fallback.className = "noosphere__image-fallback";
      fallback.textContent = img.alt || "图片暂时无法加载";
      img.replaceWith(fallback);
    };
    img.addEventListener("error", showFallback, { once: true });
    if (url) img.src = url;
    else showFallback();
  });
}

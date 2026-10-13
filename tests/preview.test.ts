// @vitest-environment jsdom
/** Markdown 预览的资源地址、排版与外部内容隔离验证。 */
import { describe, expect, it, vi } from "vitest";
import { renderArticlePreview, renderStreamingArticlePreview, reviewPreviewText } from "../src/article/preview";

function render(html: string): HTMLElement {
  const element = document.createElement("article");
  renderArticlePreview(element, "# 原稿", "https://example.com/posts/article", { ProtylePreviewStr: () => html });
  return element;
}

describe("SiYuan article preview", () => {
  it("hides legacy self-page image placeholders while retaining real image addresses", () => {
    const renderer = { ProtylePreviewStr: vi.fn((_name: string, markdown: string) => `<p>${markdown}</p>`) };
    const element = document.createElement("article");
    renderArticlePreview(element, "![](https://example.com/post)\n![配图](https://example.com/image?id=1)\n[来源](https://example.com/post)", "https://example.com/post", renderer);
    expect(renderer.ProtylePreviewStr.mock.calls[0][1]).toBe("\n![配图](https://example.com/image?id=1)\n[来源](https://example.com/post)");
  });

  it("preserves formatted headings, tables, code and linked images", () => {
    const element = render('<h1>标题</h1><blockquote>引用</blockquote><table><tr><td>数据</td></tr></table><pre><code>code</code></pre><a href="../full"><img src="../photo.jpg" alt="照片"></a>');
    expect(element.querySelector("h1")?.textContent).toBe("标题");
    expect(element.querySelector("table")).not.toBeNull();
    expect(element.querySelector("pre code")?.textContent).toBe("code");
    expect(element.querySelector("img")?.src).toBe("https://example.com/photo.jpg");
    expect(element.querySelector("img")?.referrerPolicy).toBe("no-referrer");
    expect(element.querySelector("a")?.href).toBe("https://example.com/full");
  });

  it("resolves local assets against SiYuan rather than the source website", () => {
    const element = render('<img src="assets/local.png"><img src="//cdn.example.com/image.png">');
    const images = element.querySelectorAll("img");
    expect(images[0].src).toBe(`${window.location.origin}/assets/local.png`);
    expect(images[1].src).toBe("https://cdn.example.com/image.png");
  });

  it("removes active content, dangerous URLs and event handlers", () => {
    const element = render('<script>alert(1)</script><iframe src="https://bad.example"></iframe><img src="javascript:alert(1)" onerror="alert(1)"><a href="javascript:alert(1)">链接</a><div style="position:fixed">正文</div>');
    expect(element.querySelector("script, iframe, [onerror], [style]")).toBeNull();
    expect(element.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).toContain("正文");
  });

  it("shows useful fallback text when an image fails to load", () => {
    const element = render('<img src="/missing.png" alt="研究图表">');
    element.querySelector("img")!.dispatchEvent(new Event("error"));
    expect(element.querySelector(".noosphere__image-fallback")?.textContent).toBe("研究图表");
  });

  it("keeps existing paragraphs and image fallbacks stable while safely appending streamed text", () => {
    const element = document.createElement("article");
    const renderer = { ProtylePreviewStr: (_name: string, markdown: string) => `<p>${markdown}</p><img src="/missing.png" alt="配图"><a href="javascript:alert(1)" onclick="alert(1)">链接</a>` };
    renderArticlePreview(element, "首字", "https://example.com/post", renderer, true);
    const paragraph = element.querySelector("p")!; const text = paragraph.firstChild!;
    element.querySelector("img")!.dispatchEvent(new Event("error")); const fallback = element.querySelector(".noosphere__image-fallback")!;
    renderArticlePreview(element, "首字后续", "https://example.com/post", renderer, true);
    expect(element.querySelector("p")).toBe(paragraph); expect(paragraph.firstChild).toBe(text); expect(text.textContent).toBe("首字后续");
    expect(element.querySelector(".noosphere__image-fallback")).toBe(fallback); expect(element.querySelector("img, [onclick], a[href]")).toBeNull();
  });

  it("types link labels within their final formatting without typing URLs or revealing later paragraphs", () => {
    const element = document.createElement("article");
    const article = { url: "https://example.com/post", title: "标题", markdown: "原文" };
    const renderer = { ProtylePreviewStr: (_name: string, markdown: string) => markdown.startsWith("#") ? '<h1>标题</h1><blockquote>来源</blockquote><p>\u200b</p>' : '<p><a href="https://example.com/very-long-destination">流畅链接</a></p><h2>下一节</h2><p>后续正文</p>' };
    expect(reviewPreviewText("body", article.url, renderer)).toBe("流畅链接下一节后续正文");
    renderStreamingArticlePreview(element, article, "标题", "body", renderer, 1);
    const link = element.querySelector("a")!;
    expect(link.textContent).toBe("流"); expect(link.href).toBe("https://example.com/very-long-destination");
    expect(element.querySelector<HTMLElement>("h2")?.hidden).toBe(true); expect(element.textContent).not.toContain("后续正文");
    renderStreamingArticlePreview(element, article, "标题", "body", renderer, 2);
    expect(element.querySelector("a")).toBe(link); expect(link.textContent).toBe("流畅");
    expect(element.textContent).not.toContain("very-long-destination");
  });

  it("reuses sanitized layout through animation frames instead of parsing the entire article per character", () => {
    const element = document.createElement("article"), article = { url: "https://example.com/post", title: "标题", markdown: "原稿" };
    const renderer = { ProtylePreviewStr: vi.fn((_name: string, markdown: string) => markdown.startsWith("#") ? "<h1>标题</h1>" : `<p>${"长文".repeat(1000)}</p><h2>结尾</h2>`) };
    reviewPreviewText("long body", article.url, renderer);
    renderStreamingArticlePreview(element, article, "标题", "long body", renderer, 1);
    const paragraph = element.querySelector(".noosphere__stream-body p")!, text = paragraph.firstChild!;
    for (let count = 2; count < 50; count++) renderStreamingArticlePreview(element, article, "标题", "long body", renderer, count);
    expect(renderer.ProtylePreviewStr).toHaveBeenCalledTimes(2);
    expect(element.querySelector(".noosphere__stream-body p")).toBe(paragraph); expect(paragraph.firstChild).toBe(text);
    expect(paragraph.textContent).toHaveLength(49); expect(element.querySelector<HTMLElement>("h2")?.hidden).toBe(true);
  });

  it("preserves an image failure across later text frames and batches", () => {
    const element = document.createElement("article"), article = { url: "https://example.com/post", title: "标题", markdown: "原稿" };
    const renderer = { ProtylePreviewStr: (_name: string, markdown: string) => markdown.startsWith("#") ? "<h1>标题</h1>" : `<p>前</p><img src='/photo.png' alt='配图'><p>${markdown}</p>` };
    renderStreamingArticlePreview(element, article, "标题", "后", renderer, 2);
    element.querySelector("img")!.dispatchEvent(new Event("error"));
    const fallback = element.querySelector<HTMLElement>(".noosphere__image-fallback")!;
    renderStreamingArticlePreview(element, article, "标题", "后续", renderer, 3);
    expect(element.querySelector(".noosphere__image-fallback")).toBe(fallback); expect(fallback.hidden).toBe(false);
    expect(element.querySelector("img")).toBeNull(); expect(element.textContent).toContain("后");
  });

  it("keeps streamed cached nodes sanitized while revealing later content", () => {
    const element = document.createElement("article"), article = { url: "https://example.com/post", title: "标题", markdown: "原稿" };
    const renderer = { ProtylePreviewStr: (_name: string, markdown: string) => markdown.startsWith("#") ? "<h1>标题</h1>" : '<p onclick="alert(1)">安全正文</p><script>alert(1)</script><iframe src="https://bad.example"></iframe><a href="javascript:alert(1)">链接</a>' };
    reviewPreviewText("external content", article.url, renderer);
    renderStreamingArticlePreview(element, article, "标题", "external content", renderer, 1);
    renderStreamingArticlePreview(element, article, "标题", "external content", renderer, 99);
    expect(element.querySelector("script,iframe,[onclick],a[href]")).toBeNull(); expect(element.textContent).toContain("安全正文链接");
  });
});

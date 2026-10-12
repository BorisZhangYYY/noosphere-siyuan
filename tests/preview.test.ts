// @vitest-environment jsdom
/** Markdown 预览的资源地址、排版与外部内容隔离验证。 */
import { describe, expect, it } from "vitest";
import { renderArticlePreview } from "../src/article/preview";

function render(html: string): HTMLElement {
  const element = document.createElement("article");
  renderArticlePreview(element, "# 原稿", "https://example.com/posts/article", { ProtylePreviewStr: () => html });
  return element;
}

describe("SiYuan article preview", () => {
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
});

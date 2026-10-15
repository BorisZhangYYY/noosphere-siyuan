// @vitest-environment jsdom
/** 原生结构与元数据组装、图片取舍和正式导入之间的数据完整性验证。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEditorImageChoices, composeBlockDOM, localizeEditorState, sanitizeBlockDOM } from "../src/article/editor";
import { appendArticle } from "../src/siyuan/writer";
import type { Lute } from "siyuan";

const article = { title: "标题", url: "https://example.com/article", markdown: "正文", author: "作者", capturedAt: "2026-10-14T01:00:00Z" };
const metadataRenderer = { Md2BlockDOM: (markdown: string) => {
  const quote = document.createElement("div"); quote.dataset.type = "NodeBlockquote"; quote.dataset.nodeId = "metadata-id";
  markdown.split("\n>\n").forEach(line => { const p = document.createElement("div"); p.textContent = line.replace(/^> /, ""); quote.append(p); });
  return quote.outerHTML;
} };
const blockDOM = '<div data-node-id="heading" data-type="NodeHeading"><div contenteditable="true" spellcheck="false">标题</div></div><div data-node-id="body" data-type="NodeParagraph"><div contenteditable="true" spellcheck="false"><span data-type="text" style="color: red">有颜色的正文</span><span data-type="block-ref" data-id="heading">本篇标题</span><span data-type="block-ref" data-id="existing-block">已有笔记</span><span data-type="img"><img src="https://example.com/image.png"></span></div></div>';
afterEach(() => vi.unstubAllGlobals());

describe("native article structure", () => {
  it("places multi-paragraph source metadata after the title and replaces it once", () => {
    const first = composeBlockDOM(article, blockDOM, metadataRenderer as Pick<Lute, "Md2BlockDOM">);
    const second = composeBlockDOM({ ...article, author: "新作者" }, first, metadataRenderer as Pick<Lute, "Md2BlockDOM">);
    const div = document.createElement("div"); div.innerHTML = second;
    expect(div.children[1].getAttribute("data-type")).toBe("NodeBlockquote");
    expect(div.querySelectorAll("[data-noosphere-metadata]")).toHaveLength(1);
    expect(div.children[1].children).toHaveLength(3);
    expect(div.textContent).toContain("新作者"); expect(second).toContain('style="color: red"');
  });

  it("removes scripts and event handlers while preserving native formatting and references", () => {
    const safe = sanitizeBlockDOM(blockDOM + '<script>alert(1)</script><img src="x" onerror="alert(1)"><iframe src="https://bad.example"></iframe>');
    expect(safe).not.toContain("script"); expect(safe).not.toContain("onerror"); expect(safe).not.toContain("iframe");
    expect(safe).toContain('style="color: red"'); expect(safe).toContain('data-id="existing-block"');
  });

  it("removes and restores image choices without rebuilding or losing native text formatting", () => {
    const state = { markdown: "正文 ![图](https://example.com/image.png)", nativeMarkdown: "正文", blockDOM };
    const decision = { full: "![图](https://example.com/image.png)", alt: "图", url: "https://example.com/image.png", description: "", recommendedRemove: false, remove: true };
    const removed = applyEditorImageChoices(state, "正文", [decision]);
    expect(removed.blockDOM).not.toContain("<img"); expect(removed.blockDOM).toContain('style="color: red"');
    const restored = applyEditorImageChoices(removed, state.markdown, [{ ...decision, remove: false }]);
    expect(restored.blockDOM).toBe(blockDOM);
  });

  it("updates localized image paths and preserves native block references", () => {
    const result = localizeEditorState({ markdown: "正文", nativeMarkdown: "正文", blockDOM }, "正文 ![](assets/local.png)", { "https://example.com/image.png": "assets/local.png" });
    expect(result.blockDOM).toContain('src="assets/local.png"'); expect(result.blockDOM).toContain('data-id="existing-block"');
  });

  it("imports native formatting with fresh block IDs and remaps only references within this article", async () => {
    let nextId = 0;
    vi.stubGlobal("window", Object.assign(window, { Lute: { New: () => metadataRenderer, NewNodeID: () => `new-id-${++nextId}` } }));
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string); requests.push(body);
      return { ok: true, json: async () => ({ code: 0, data: body.id ? { type: "doc" } : [{ doOperations: [{ id: "inserted" }] }] }) };
    }));
    await appendArticle("20261014100000-abcdefg", article, "正文", blockDOM);
    expect(requests[1].dataType).toBe("dom");
    const div = document.createElement("div"); div.innerHTML = requests[1].data as string;
    const headingId = div.firstElementChild!.getAttribute("data-node-id");
    expect(headingId).not.toBe("heading");
    expect(div.querySelector('[data-type="block-ref"]')?.getAttribute("data-id")).toBe(headingId);
    expect(div.querySelector('[data-id="existing-block"]')).not.toBeNull();
    expect(requests[1].data).toContain('style="color: red"');
    const before = requests[1].data;
    await appendArticle("20261014100000-abcdefg", article, "正文", blockDOM);
    expect(requests[3].data).not.toBe(before);
  });
});

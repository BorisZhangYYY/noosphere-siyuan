// @vitest-environment jsdom
/** 图片插入走 Protyle 的保存选区入口，保留正文格式并拒绝无效/来源选区。 */
import { afterEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ insert: vi.fn(), transaction: vi.fn(), editor: undefined as any }));
vi.mock("siyuan", () => ({
  Protyle: class {
    protyle: any;
    constructor(_app: unknown, host: HTMLElement) {
      const content = document.createElement("div"); host.append(content);
      const text = (html: string): string => {
        const div = document.createElement("div"); div.innerHTML = html;
        div.querySelectorAll("img").forEach(img => img.replaceWith(document.createTextNode(`![${img.alt}](${img.getAttribute("src")})`)));
        return div.textContent || "";
      };
      this.protyle = { wysiwyg: { element: content }, toolbar: {}, lute: {
        Md2BlockDOM: (markdown: string) => `<div data-type="NodeParagraph"><div contenteditable="true" spellcheck="false">${markdown}</div></div>`,
        HTML2BlockDOM: (html: string) => html, BlockDOM2Md: text, BlockDOM2StdMd: text,
      } };
      runtime.editor = this;
    }
    disable(): void {} enable(): void {} destroy(): void {} isUploading(): boolean { return false; }
    transaction(operations: unknown[], undo: unknown[]): void { runtime.transaction(operations, undo); }
    insert(html: string, isBlock: boolean, useProtyleRange: boolean): void {
      runtime.insert(html, isBlock, useProtyleRange);
      const range = this.protyle.toolbar.range as Range;
      range.deleteContents();
      range.insertNode(range.createContextualFragment(html));
    }
  }, ProtyleMethod: {},
}));

import { NativeArticleEditor, articleImageHTML } from "../src/article/editor";
const image = { url: "https://example.com/image.png?a=1&b=2", alt: '图 "说明"' };
const article = { title: "文章", url: "https://example.com/post", markdown: "前半文字后半文字" };
let active: NativeArticleEditor | undefined;
afterEach(() => { active?.destroy(); active = undefined; document.body.replaceChildren(); runtime.insert.mockClear(); runtime.transaction.mockClear(); window.getSelection()?.removeAllRanges(); });

function start(): { content: HTMLElement; changed: ReturnType<typeof vi.fn> } {
  const host = document.createElement("div"); document.body.append(host);
  const changed = vi.fn();
  active = new NativeArticleEditor({} as any, host, article, article.markdown, { markdown: article.markdown, nativeMarkdown: article.markdown,
    blockDOM: '<div data-type="NodeParagraph" data-node-id="body"><div contenteditable="true" spellcheck="false"><span style="color: red">前半文字后半文字</span></div></div>' }, changed);
  return { content: runtime.editor.protyle.wysiwyg.element, changed };
}
function select(node: Node, offset: number): void {
  const range = document.createRange(); range.setStart(node, offset); range.collapse(true);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); document.dispatchEvent(new Event("selectionchange"));
}

it("uses the last body caret after focus moves to assets, preserving surrounding formatting", () => {
  const { content, changed } = start(); active!.setReadOnly(false);
  select(content.querySelector('[data-node-id="body"] span')!.firstChild!, 4);
  const button = document.createElement("button"); button.textContent = "素材"; document.body.append(button); select(button.firstChild!, 0);
  expect(active!.insertImage(image)).toBe(true);
  expect(runtime.insert).toHaveBeenCalledWith(expect.stringContaining("<img"), false, true);
  const snapshot = active!.snapshot();
  expect(snapshot.blockDOM).toContain('style="color: red"');
  expect(snapshot.blockDOM.indexOf("<img")).toBeGreaterThan(snapshot.blockDOM.indexOf("前半文字"));
  expect(snapshot.blockDOM.indexOf("<img")).toBeLessThan(snapshot.blockDOM.indexOf("后半文字"));
  expect(changed).toHaveBeenCalledOnce();
});

it("never appends when there is no body caret, the editor is readonly, or metadata is selected", () => {
  const { content } = start();
  expect(active!.insertImage(image)).toBe(false);
  active!.setReadOnly(false);
  expect(active!.insertImage(image)).toBe(false);
  select(content.querySelector('[data-node-id="body"] span')!.firstChild!, 2);
  select(content.querySelector('[data-noosphere-metadata] [contenteditable]')!.firstChild!, 1);
  expect(active!.insertImage(image)).toBe(false);
  expect(runtime.insert).not.toHaveBeenCalled();
});

it("passes the complete saved selection to Protyle and replaces only the chosen placeholder", () => {
  const { content, changed } = start(); active!.setReadOnly(false);
  const span = content.querySelector('[data-node-id="body"] span')!;
  span.textContent = "前半【图片引用待确认】后半【图片引用待确认】";
  const range = document.createRange(); range.setStart(span.firstChild!, 2); range.setEnd(span.firstChild!, 11);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); document.dispatchEvent(new Event("selectionchange"));
  const button = document.createElement("button"); button.textContent = "插入"; document.body.append(button); select(button.firstChild!, 0);
  expect(active!.insertImage(image)).toBe(true);
  const snapshot = active!.snapshot();
  expect(snapshot.nativeMarkdown).toContain(`前半![${image.alt}](${image.url})后半【图片引用待确认】`);
  expect(snapshot.blockDOM).toContain('style="color: red"');
  expect(changed).toHaveBeenCalledOnce();
});

it("creates safe transferable image HTML using the source address", () => {
  const html = articleImageHTML({ url: "/photo.png", alt: '<img onerror="bad">' }, article.url)!;
  const div = document.createElement("div"); div.innerHTML = html;
  expect(div.children).toHaveLength(1); expect(div.firstElementChild!.getAttribute("src")).toBe("https://example.com/photo.png");
  expect(div.firstElementChild!.hasAttribute("onerror")).toBe(false);
  expect(articleImageHTML({ url: "javascript:alert(1)", alt: "" }, article.url)).toBeUndefined();
});

it("inserts the entire ordered selection in one transaction and rejects unsafe batches without partial insertion", () => {
  const { content } = start(); active!.setReadOnly(false);
  select(content.querySelector('[data-node-id="body"] span')!.firstChild!, 4);
  const second = { url: "https://example.com/second.png", alt: "第二张" };
  expect(active!.insertImages([second, { url: "javascript:bad()", alt: "bad" }])).toBe(false);
  expect(runtime.insert).not.toHaveBeenCalled();
  expect(active!.insertImages([second, image])).toBe(true);
  expect(runtime.insert).toHaveBeenCalledOnce();
  expect(Array.from(content.querySelectorAll('img'), node => node.getAttribute('src'))).toEqual([second.url, image.url]);
  expect(active!.snapshot().blockDOM).toContain('style="color: red"');
});

it("removes every selected occurrence across blocks in one reversible update while preserving other images and metadata", () => {
  const { content } = start();
  const paragraph = content.querySelector('[data-node-id="body"] [contenteditable]')!;
  paragraph.insertAdjacentHTML("beforeend", '<span data-type="img"><img src="https://example.com/a.png"></span><img src="https://example.com/keep.png">');
  content.insertAdjacentHTML("beforeend", '<div data-node-id="second" data-type="NodeParagraph"><div contenteditable="true">后文<img src="https://example.com/a.png"><img src="/assets/b.png"></div></div>');
  content.querySelector('[data-noosphere-metadata]')!.insertAdjacentHTML("beforeend", '<img src="https://example.com/a.png">');
  const images = [{ url: "https://example.com/a.png" }, { url: "https://example.com/original-b.png", previewUrl: "assets/b.png" }];
  expect(active!.removeImages(images)).toBe(false);
  active!.setReadOnly(false);
  expect(active!.removeImages(images)).toBe(true);
  expect(content.querySelectorAll('img[src="https://example.com/a.png"]')).toHaveLength(1);
  expect(content.querySelector('[data-noosphere-metadata] img')).not.toBeNull();
  expect(content.querySelector('img[src="/assets/b.png"]')).toBeNull();
  expect(content.querySelector('img[src="https://example.com/keep.png"]')).not.toBeNull();
  expect(active!.snapshot().blockDOM).toContain('style="color: red"');
  expect(content.textContent).toContain("后文");
  expect(runtime.transaction).toHaveBeenCalledOnce();
  const [operations, undo] = runtime.transaction.mock.calls[0];
  expect(operations.map((op: { id: string }) => op.id)).toEqual(["body", "second"]);
  expect(undo[0].data).toContain('data-type="img"');
  expect(undo[1].data).toContain('/assets/b.png');
});

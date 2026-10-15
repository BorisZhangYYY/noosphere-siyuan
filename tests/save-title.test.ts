// @vitest-environment jsdom
/** 验证空白文档标题、初始占位替换、失败重试及原生引用的保存语义。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendArticle } from "../src/siyuan/writer";
import { kernelPost } from "../src/siyuan/api";

vi.mock("../src/siyuan/api", () => ({ kernelPost: vi.fn() }));
const documentId = "20261014100000-aaaaaaa", placeholderId = "20261014100000-bbbbbbb";
const article = { title: "文章标题", url: "https://example.com/article", markdown: "正文", author: "作者" };
let attrs: Record<string, string>, children: Array<{ id: string; type: string; content: string; markdown: string }>;

beforeEach(() => {
  attrs = { type: "doc", title: "未命名文档", "custom-sy-title-empty": "true" };
  children = [{ id: placeholderId, type: "p", content: "", markdown: "" }];
  vi.mocked(kernelPost).mockImplementation(async (path, payload) => {
    if (path === "/api/attr/getBlockAttrs") return { ...attrs };
    if (path === "/api/block/getChildBlocks") return structuredClone(children);
    if (path === "/api/filetree/renameDocByID") {
      attrs.title = (payload as { title: string }).title; delete attrs["custom-sy-title-empty"]; return null;
    }
    return [{ doOperations: [{ action: "delete", id: placeholderId }, { action: "insert", id: "20261014100000-ccccccc" }] }];
  });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("saving an article title", () => {
  it("sets the document title and replaces the initial empty paragraph without a duplicate heading", async () => {
    const inserted = await appendArticle(documentId, article, "# 文章标题\n\n正文\n\n## 小节");
    expect(inserted).toBe("20261014100000-ccccccc");
    expect(kernelPost).toHaveBeenCalledWith("/api/filetree/renameDocByID", { id: documentId, title: "文章标题" });
    const write = vi.mocked(kernelPost).mock.calls.find(([path]) => path === "/api/block/updateBlock")!;
    expect(write[1]).toEqual({ id: documentId, dataType: "markdown", data: expect.stringContaining("正文") });
    expect((write[1] as { data: string }).data).toContain("> 来源：");
    expect((write[1] as { data: string }).data).toContain("## 小节");
    expect((write[1] as { data: string }).data).not.toContain("# 文章标题");
    expect(vi.mocked(kernelPost).mock.calls.some(([path]) => path === "/api/block/appendBlock")).toBe(false);
  });

  it("appends to an existing named document with an article heading", async () => {
    attrs = { type: "doc", title: "我的资料" };
    await appendArticle(documentId, article, "正文");
    expect(vi.mocked(kernelPost).mock.calls.map(([path]) => path)).toEqual(["/api/attr/getBlockAttrs", "/api/block/appendBlock"]);
    expect(kernelPost).toHaveBeenLastCalledWith("/api/block/appendBlock", expect.objectContaining({ parentID: documentId, data: expect.stringContaining("## 文章标题") }));
  });

  it("keeps an unnamed document's existing image instead of treating it as empty", async () => {
    children[0].markdown = "![](assets/diagram.png)";
    await appendArticle(documentId, article, "正文");
    expect(vi.mocked(kernelPost).mock.calls.some(([path]) => path === "/api/filetree/renameDocByID" || path === "/api/block/updateBlock")).toBe(false);
    expect(kernelPost).toHaveBeenLastCalledWith("/api/block/appendBlock", expect.objectContaining({ data: expect.stringContaining("## 文章标题") }));
  });

  it("does not write any article body when naming fails", async () => {
    const normal = vi.mocked(kernelPost).getMockImplementation()!;
    vi.mocked(kernelPost).mockImplementation(async (path, payload) => {
      if (path === "/api/filetree/renameDocByID") throw new Error("命名失败");
      return normal(path, payload);
    });
    await expect(appendArticle(documentId, article, "正文")).rejects.toThrow("命名失败");
    expect(vi.mocked(kernelPost).mock.calls.some(([path]) => /appendBlock|updateBlock/.test(path))).toBe(false);
  });

  it("retries a failed body write to the same named empty document without duplicating the heading", async () => {
    const normal = vi.mocked(kernelPost).getMockImplementation()!;
    let fail = true;
    vi.mocked(kernelPost).mockImplementation(async (path, payload) => {
      if (path === "/api/block/updateBlock" && fail) { fail = false; throw new Error("写入失败"); }
      return normal(path, payload);
    });
    const source = { ...article, title: "C/C++: FAQ?" };
    await expect(appendArticle(documentId, source, "正文")).rejects.toThrow("写入失败");
    expect(attrs.title).toBe("C／C++： FAQ？");
    await appendArticle(documentId, source, "正文");
    expect(vi.mocked(kernelPost).mock.calls.filter(([path]) => path === "/api/filetree/renameDocByID")).toHaveLength(1);
    expect((vi.mocked(kernelPost).mock.calls.at(-1)![1] as { data: string }).data).toMatch(/^> 来源：/);
  });

  it("stops before replacing a placeholder that has received concurrent content", async () => {
    const normal = vi.mocked(kernelPost).getMockImplementation()!;
    vi.mocked(kernelPost).mockImplementation(async (path, payload) => {
      const result = await normal(path, payload);
      if (path === "/api/filetree/renameDocByID") children[0] = { ...children[0], content: "用户新输入", markdown: "用户新输入" };
      return result;
    });
    await expect(appendArticle(documentId, article, "正文")).rejects.toThrow("内容已变化");
    expect(vi.mocked(kernelPost).mock.calls.some(([path]) => path === "/api/block/updateBlock")).toBe(false);
  });

  it("promotes a native title while keeping body formatting and remapping its references to the document", async () => {
    let sequence = 0;
    vi.stubGlobal("window", Object.assign(window, { Lute: { NewNodeID: () => `fresh-${++sequence}`, New: () => ({
      Md2BlockDOM: () => '<div data-node-id="metadata" data-type="NodeBlockquote"><div data-node-id="source" data-type="NodeParagraph"><div contenteditable="true">来源</div></div></div>',
    }) } }));
    const html = '<div data-node-id="title" data-type="NodeHeading"><div contenteditable="true" spellcheck="false"><strong>文章标题</strong></div></div><div data-node-id="paragraph" data-type="NodeParagraph"><div contenteditable="true" spellcheck="false"><span style="color: red">正文</span><span data-type="block-ref" data-id="title">文章标题</span><span data-type="block-ref" data-id="other-note">其他笔记</span></div></div>';
    await appendArticle(documentId, article, "正文", html);
    const write = vi.mocked(kernelPost).mock.calls.at(-1)!;
    expect(write[0]).toBe("/api/block/updateBlock");
    const data = (write[1] as { data: string; dataType: string });
    expect(data.dataType).toBe("dom"); expect(data.data).not.toContain('data-type="NodeHeading"');
    expect(data.data).toContain(`data-id="${documentId}"`); expect(data.data).toContain('data-id="other-note"');
    expect(data.data).toContain('style="color: red"'); expect(data.data).not.toContain("data-noosphere-metadata");
  });
});

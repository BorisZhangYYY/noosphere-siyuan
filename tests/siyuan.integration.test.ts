/** 可选内核集成测试：仅对调用者提供的独立测试实例创建临时笔记本。 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import https from "node:https";
import { kernelPost } from "../src/siyuan/api";
import { discoverCategories, refreshCategoryIndex } from "../src/siyuan/tree";
import { articleIdentity, ensureArticleDocument } from "../src/siyuan/destination";
import { locateDocument, type DocumentLocation } from "../src/siyuan/location";
import { CategoryIndexMaintenance } from "../src/siyuan/index-maintenance";

const base = process.env.SIYUAN_TEST_URL;
const token = process.env.SIYUAN_TEST_TOKEN;
describe.skipIf(!base || !token)("isolated SiYuan kernel", () => {
  let notebook: string, otherNotebook: string, root: DocumentLocation, category: string, outside: string;
  const requests: string[] = [];
  const article = { title: "同名文章", url: "https://example.com/post?a=1&b=2", markdown: "# 同名文章\n\n正文" };
  async function create(path: string, markdown: string, box = notebook): Promise<string> {
    return kernelPost("/api/filetree/createDocWithMd", { notebook: box, path, markdown });
  }
  async function attrs(id: string, values: Record<string, string>): Promise<void> {
    await kernelPost("/api/attr/setBlockAttrs", { id, attrs: values });
  }
  beforeAll(async () => {
    const target = new URL(base!);
    if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error("集成测试只允许连接本机的独立测试内核");
    // 自签名证书仅用于本机临时实例；生产请求封装不变。
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      requests.push(path);
      const req = https.request(new URL(path, target), { method: init.method, rejectUnauthorized: false,
        headers: { ...init.headers as Record<string, string>, Authorization: `Token ${token}` } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      });
      req.on("error", reject); req.end(init.body as string);
    }));
    notebook = (await kernelPost<{ notebook: { id: string } }>("/api/notebook/createNotebook", { name: `知流集成测试-${Date.now()}` })).notebook.id;
    otherNotebook = (await kernelPost<{ notebook: { id: string } }>("/api/notebook/createNotebook", { name: `知流范围外-${Date.now()}` })).notebook.id;
    root = await locateDocument(await create("/根", "分类根介绍"));
    category = await create("/根/AI", "收集人工智能、模型与机器学习文章。");
    await attrs(category, { "custom-zl-category": "true" });
    const nested = await create("/根/AI/中间目录/大模型", "收集大型语言模型文章。");
    await attrs(nested, { "custom-zl-category": "true" });
    outside = await create("/范围外/游戏", "游戏文章");
    await attrs(outside, { "custom-zl-category": "true" });
    const other = await create("/AI", "另一个笔记本的分类", otherNotebook);
    await attrs(other, { "custom-zl-category": "true" });
    await vi.waitFor(async () => expect((await discoverCategories(root)).length).toBe(2), { timeout: 10000 });
  }, 20000);
  afterAll(async () => {
    try {
      if (notebook) await kernelPost("/api/notebook/removeNotebook", { notebook });
      if (otherNotebook) await kernelPost("/api/notebook/removeNotebook", { notebook: otherNotebook });
    } finally { vi.unstubAllGlobals(); }
  });

  it("discovers only the selected subtree with full paths and body descriptions", async () => {
    const nodes = await discoverCategories(root);
    expect(nodes.map(node => node.path)).toEqual(["AI", "AI / 中间目录 / 大模型"]);
    expect(nodes.find(node => node.id === category)?.description).toBe("收集人工智能、模型与机器学习文章。");
    expect(nodes.some(node => node.id === outside)).toBe(false);
    expect((await discoverCategories(notebook)).length).toBe(3);
  });
  it("keeps unrelated same-title notes and updates a source after its title changes", async () => {
    const unrelated = await create("/根/AI/同名文章", "用户手写内容");
    const result = await ensureArticleDocument(category, article, article.markdown, { root });
    expect(result.created).toBe(true); expect(result.documentId).not.toBe(unrelated);
    expect((await locateDocument(result.documentId)).hpath).toBe("/根/AI/同名文章（2）");
    expect((await kernelPost<{ kramdown: string }>("/api/block/getBlockKramdown", { id: unrelated })).kramdown).toContain("用户手写内容");
    const updated = await ensureArticleDocument(category, { ...article, title: "新标题" }, "# 新标题\n\n更新正文", { root });
    expect(updated).toMatchObject({ documentId: result.documentId, created: false });
    expect((await locateDocument(updated.documentId)).hpath).toBe("/根/AI/新标题");
    const savedAttrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id: result.documentId });
    expect(savedAttrs["custom-zl-article"]).toBe(articleIdentity(article));
    expect(savedAttrs["custom-sy-readonly"]).not.toBe("true");
    expect((await kernelPost<{ kramdown: string }>("/api/block/getBlockKramdown", { id: result.documentId })).kramdown).toContain("更新正文");
  });
  it("rejects destinations outside the anchor", async () => {
    await expect(ensureArticleDocument(outside, article, "正文", { root })).rejects.toThrow("不在所选锚点下");
  });
  it("creates and refreshes a managed index without touching the introduction", async () => {
    expect(await refreshCategoryIndex(category)).toBeNull();
    const indexId = await refreshCategoryIndex(category, { create: true });
    expect(indexId).toBeTruthy();
    const writes = requests.filter(path => path === '/api/block/updateBlock').length;
    expect(await refreshCategoryIndex(category)).toBe(indexId);
    expect(requests.filter(path => path === '/api/block/updateBlock')).toHaveLength(writes);
    const md = (await kernelPost<{ kramdown: string }>("/api/block/getBlockKramdown", { id: category })).kramdown;
    expect(md).toContain("收集人工智能、模型与机器学习文章。");
    expect(md).toContain("((");
    expect(md).toContain("中间目录"); expect(md).toContain("大模型");
    expect(md).toContain('custom-zl-index="true"');
    expect((await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id: category }))["custom-sy-readonly"]).toBe("true");
    await attrs(category, { "custom-sy-readonly": "false" });
    await refreshCategoryIndex(category);
    expect((await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id: category }))["custom-sy-readonly"]).toBe("false");
  });
  it("updates an open managed tree from real kernel create, rename, move and delete events", async () => {
    const errors: unknown[] = [];
    const sync = new CategoryIndexMaintenance(() => ({ rootDocumentId: '', autoCreateIndex: false }), error => errors.push(error));
    const url = new URL(base!); url.protocol = 'ws:'; url.pathname = '/ws'; url.search = `?app=noosphere-test&id=index-${Date.now()}&type=main`;
    const socket = new WebSocket(url);
    socket.addEventListener('message', message => sync.onMessage({ detail: JSON.parse(String(message.data)) }));
    const content = async (): Promise<string> => (await kernelPost<{ kramdown: string }>("/api/block/getBlockKramdown", { id: category })).kramdown;
    try {
      await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('临时内核 WebSocket 连接失败')), { once: true }); });
      const added = await create('/根/AI/手动新建', '实时更新测试');
      await vi.waitFor(async () => expect(await content()).toContain(added), { timeout: 8000 });
      await kernelPost('/api/filetree/renameDocByID', { id: added, title: '手动改名' });
      await vi.waitFor(async () => expect(await content()).toContain('手动改名'), { timeout: 8000 });
      await kernelPost('/api/filetree/moveDocsByID', { fromIDs: [added], toID: outside });
      await vi.waitFor(async () => expect(await content()).not.toContain(added), { timeout: 8000 });
      await kernelPost('/api/filetree/moveDocsByID', { fromIDs: [added], toID: category });
      await vi.waitFor(async () => expect(await content()).toContain(added), { timeout: 8000 });
      await kernelPost('/api/filetree/removeDocByID', { id: added });
      await vi.waitFor(async () => expect(await content()).not.toContain(added), { timeout: 8000 });
      expect(errors).toEqual([]);
    } finally { sync.stop(); socket.close(); }
  }, 30000);
  it("clears stale entries when the last child document is removed", async () => {
    const empty = await create("/根/空分类", "空分类介绍");
    const child = await create("/根/空分类/待删除文章", "文章");
    await refreshCategoryIndex(empty, { create: true });
    await kernelPost("/api/filetree/removeDocByID", { id: child });
    await refreshCategoryIndex(empty);
    const md = (await kernelPost<{ kramdown: string }>("/api/block/getBlockKramdown", { id: empty })).kramdown;
    expect(md).toContain("暂无子文档。"); expect(md).not.toContain(child);
  });
});

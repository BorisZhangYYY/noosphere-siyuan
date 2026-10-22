/** 可选内核集成测试：仅对调用者提供的独立测试实例创建临时笔记本。 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import https from "node:https";
import { kernelPost } from "../src/siyuan/api";
import { discoverCategories, refreshCategoryIndex } from "../src/siyuan/tree";
import { articleIdentity, ensureArticleDocument } from "../src/siyuan/destination";
import { locateDocument, type DocumentLocation } from "../src/siyuan/location";
import { CategoryIndexMaintenance } from "../src/siyuan/index-maintenance";
import { createCategory, ensureClassificationRoot, loadManagedCategories, updateCategory } from "../src/siyuan/category-management";
import { categoryDescription } from "../src/siyuan/tree";

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
  it("creates nested categories, structured descriptions and a root directory and help", async () => {
    const rootId = await create('/分类管理根', '根文档中的用户说明必须保留。');
    const ai = await createCategory(rootId, { name: '人工智能', description: '收集智能体、工具调用和机器学习应用。', parentId: rootId });
    const llm = await createCategory(rootId, { name: '大模型', description: '收集模型训练、推理、提示词与 RAG。', parentId: ai });
    const sample = await create('/分类管理根/人工智能/大模型/样文', '文章可编辑');
    expect(await ensureClassificationRoot(rootId)).toBe(rootId);
    const rootMd = (await kernelPost<{ kramdown: string }>('/api/block/getBlockKramdown', { id: rootId })).kramdown;
    expect(rootMd).toContain('根文档中的用户说明必须保留'); expect(rootMd).toContain(ai); expect(rootMd).toContain(llm); expect(rootMd).toContain(sample);
    const depth = (id: string): number => rootMd.split('\n').find(line => line.includes(`((${id} '`))!.match(/^\s*/)![0].length;
    expect(depth(sample)).toBeGreaterThan(depth(llm)); expect(depth(llm)).toBeGreaterThan(depth(ai));
    const referenceLine = (id: string): string => rootMd.split('\n').find(line => line.includes(`((${id} '`))!;
    expect(referenceLine(ai)).toContain('📚'); expect(referenceLine(ai)).toContain('**');
    expect(referenceLine(sample)).toContain('📄'); expect(referenceLine(sample)).not.toContain('**');
    expect(rootMd.indexOf('## 目录')).toBeLessThan(rootMd.indexOf('## 说明'));
    expect(rootMd).not.toContain('## 分类使用说明');
    const rootAttrs = await kernelPost<Record<string, string>>('/api/attr/getBlockAttrs', { id: rootId });
    const help = rootAttrs['custom-zl-root-help-block'];
    const helpItems = await kernelPost<Array<{ id: string; type: string }>>('/api/block/getChildBlocks', { id: help });
    expect(helpItems).toHaveLength(8);
    const helpMd = (await kernelPost<{ kramdown: string }>('/api/block/getBlockKramdown', { id: help })).kramdown;
    expect(helpMd).toContain('**目录标识**'); expect(helpMd).toContain('**误删修复**');
    await ensureClassificationRoot(rootId);
    expect((await kernelPost<Record<string, string>>('/api/attr/getBlockAttrs', { id: rootId }))['custom-zl-root-help-block']).toBe(help);
    const md = (await kernelPost<{ kramdown: string }>('/api/block/getBlockKramdown', { id: ai })).kramdown;
    expect(md).toContain('## 分类描述'); expect(md).toContain('custom-zl-description="true"'); expect(md).toContain('## 文章目录');
    expect((await discoverCategories(rootId)).map(node => node.path)).toEqual(['人工智能', '人工智能 / 大模型']);
    expect((await kernelPost<Record<string, string>>('/api/attr/getBlockAttrs', { id: ai }))['custom-sy-readonly']).toBe('true');
    expect((await kernelPost<Record<string, string>>('/api/attr/getBlockAttrs', { id: sample }))['custom-sy-readonly']).not.toBe('true');
  }, 20000);
  it("updates descriptions without replacing user notes or the managed directory and tolerates renamed headings", async () => {
    const rootId = await create('/描述编辑根', '根介绍');
    const id = await createCategory(rootId, { name: '游戏', description: '游戏设计旧描述', parentId: rootId });
    await kernelPost('/api/block/appendBlock', { parentID: id, dataType: 'markdown', data: '## 用户备注\n\n用户手写内容保持完整。' });
    const children = await kernelPost<Array<{ id: string; type: string; content?: string }>>('/api/block/getChildBlocks', { id });
    const index = children.find(child => child.type === 'p' && child.content?.includes('暂无子文档'))!;
    const directoryHeading = children.find(child => child.type === 'h' && child.content === '文章目录')!;
    await kernelPost('/api/block/updateBlock', { id: directoryHeading.id, dataType: 'markdown', data: '## 目录' });
    await attrs(id, { 'custom-sy-readonly': 'false' });
    await updateCategory(rootId, id, { name: '游戏设计', description: '收集游戏机制设计，不包括小说叙事。', parentId: rootId });
    const md = (await kernelPost<{ kramdown: string }>('/api/block/getBlockKramdown', { id })).kramdown;
    expect(md).toContain('用户手写内容保持完整'); expect(md).toContain(index.id); expect(md).toContain('## 目录');
    expect(await categoryDescription(id, '过时属性')).toBe('收集游戏机制设计，不包括小说叙事。');
    const heading = children.find(child => child.type === 'h' && child.content === '分类描述')!;
    await kernelPost('/api/block/updateBlock', { id: heading.id, dataType: 'markdown', data: '## 收录说明' });
    expect(await categoryDescription(id, '过时属性')).toBe('收集游戏机制设计，不包括小说叙事。');
    expect((await locateDocument(id)).hpath).toBe('/描述编辑根/游戏设计');
    expect((await kernelPost<Record<string, string>>('/api/attr/getBlockAttrs', { id }))['custom-sy-readonly']).toBe('false');
  }, 20000);
  it("migrates old introduction paragraphs and keeps unrelated same-title documents safe", async () => {
    const rootId = await create('/迁移管理根', '根介绍');
    const old = await create('/迁移管理根/旧分类', '旧的孤立介绍\n\n## 目录\n\n暂无子文档。\n{: custom-zl-index="true"}\n\n## 备注\n\n用户备注');
    await attrs(old, { 'custom-zl-category': 'true', 'custom-zl-desc': '旧属性中的有效介绍' });
    const managed = await loadManagedCategories(rootId);
    expect(managed.categories.find(node => node.id === old)?.description).toBe('旧属性中的有效介绍');
    const md = (await kernelPost<{ kramdown: string }>('/api/block/getBlockKramdown', { id: old })).kramdown;
    expect(md).toContain('## 分类描述'); expect(md).toContain('用户备注'); expect(md).toContain('## 目录');
    const unrelated = await create('/迁移管理根/手写笔记', '不要覆盖');
    await expect(createCategory(rootId, { name: '手写笔记', description: '规则', parentId: rootId })).rejects.toThrow('同名');
    expect((await kernelPost<{ kramdown: string }>('/api/block/getBlockKramdown', { id: unrelated })).kramdown).toContain('不要覆盖');
    await expect(createCategory(rootId, { name: '范围外', description: '规则', parentId: outside })).rejects.toThrow('移出');
  }, 20000);
  it("uses the native notebook document without creating an overview or changing the classification scope", async () => {
    const existing = await create('/分类总览', '用户已有同名文档');
    await kernelPost('/api/block/appendBlock', { parentID: notebook, dataType: 'markdown', data: '笔记本中的用户说明必须保留。' });
    expect(await ensureClassificationRoot(notebook)).toBe(notebook);
    const top = await createCategory(notebook, { name: '笔记本根分类', description: '笔记本顶层分类', parentId: notebook });
    const nested = await createCategory(notebook, { name: '子分类', description: '嵌套分类', parentId: top });
    const anchor = await locateDocument(notebook);
    expect(anchor).toMatchObject({ id: notebook, path: '/', hpath: '', isNotebook: true });
    expect((await locateDocument(top)).hpath).toBe('/笔记本根分类');
    const saved = await ensureArticleDocument(notebook, { ...article, url: 'https://example.com/notebook-root', title: '根下文章' }, '未匹配分类的正文', { root: anchor });
    expect((await locateDocument(saved.documentId)).hpath).toBe('/根下文章');
    const managed = await loadManagedCategories(notebook);
    expect(managed.rootDocumentId).toBe(notebook);
    expect(managed.categories.find(node => node.id === nested)?.path).toBe('笔记本根分类 / 子分类');
    const content = async (): Promise<string> => (await kernelPost<{ kramdown: string }>('/api/block/getBlockKramdown', { id: notebook })).kramdown;
    const md = await content();
    expect(md).toContain('笔记本中的用户说明必须保留');
    expect(md).toContain(top); expect(md).toContain(nested); expect(md).toContain(saved.documentId); expect(md).toContain(existing);
    expect(md.indexOf('## 目录')).toBeLessThan(md.indexOf('## 说明'));
    expect(md.match(/## 目录/g)).toHaveLength(1); expect(md.match(/## 说明/g)).toHaveLength(1);
    expect((await kernelPost<Record<string, string>>('/api/attr/getBlockAttrs', { id: notebook }))['custom-sy-readonly']).toBe('true');
    await kernelPost('/api/filetree/renameDocByID', { id: top, title: '笔记本分类改名' });
    await refreshCategoryIndex(notebook);
    expect(await content()).toContain('笔记本分类改名');
    await kernelPost('/api/filetree/removeDocByID', { id: nested });
    await refreshCategoryIndex(notebook);
    expect(await content()).not.toContain(nested);
    const ids = await kernelPost<string[]>('/api/filetree/getIDsByHPath', { notebook, path: '/分类总览（2）' });
    expect(ids).toEqual([]);
    expect((await kernelPost<{ kramdown: string }>('/api/block/getBlockKramdown', { id: existing })).kramdown).toContain('用户已有同名文档');
  }, 20000);
  it("migrates owned root sections and preserves their bindings after a rename", async () => {
    const id = await create('/旧版根结构', '保留用户正文。\n\n## 分类使用说明\n\n旧说明\n{: custom-zl-classification-help="PLACEHOLDER"}\n\n## 全部分类\n\n暂无分类。\n{: custom-zl-index="true"}');
    const original = await kernelPost<Array<{ id: string; type: string; content?: string }>>('/api/block/getChildBlocks', { id });
    const oldHelp = original.find(block => block.type === 'p' && block.content === '旧说明')!;
    await attrs(id, { 'custom-zl-overview-root': id, 'custom-zl-root-help-block': oldHelp.id });
    await attrs(oldHelp.id, { 'custom-zl-classification-help': id });
    await ensureClassificationRoot(id);
    const blocks = await kernelPost<Array<{ id: string; type: string; content?: string }>>('/api/block/getChildBlocks', { id });
    const heading = blocks.find(block => block.type === 'h' && block.content === '目录')!;
    await kernelPost('/api/block/updateBlock', { id: heading.id, dataType: 'markdown', data: '## 自定义导航' });
    await ensureClassificationRoot(id);
    const md = (await kernelPost<{ kramdown: string }>('/api/block/getBlockKramdown', { id })).kramdown;
    expect(md).toContain('保留用户正文'); expect(md).toContain('## 自定义导航');
    expect(md.match(/## 说明/g)).toHaveLength(1); expect(md).not.toContain('## 全部分类');
    expect(md).not.toContain('旧说明'); expect(md.match(/\*\*目录标识\*\*/g)).toHaveLength(1);
    const helpId = (await kernelPost<Record<string, string>>('/api/attr/getBlockAttrs', { id }))['custom-zl-root-help-block'];
    const helpAttrs = await kernelPost<Record<string, string>>('/api/attr/getBlockAttrs', { id: helpId });
    expect(helpAttrs['custom-zl-classification-help']).toBe(id);
    expect(helpAttrs['custom-zl-help-version']).toBe('3');
    expect((await kernelPost<Array<{ id: string }>>('/api/block/getChildBlocks', { id: helpId })).length).toBe(8);
  });
  it("keeps all root descendants visible regardless of category markers and follows real tree changes", async () => {
    const rootId = await create('/标记变更根', '根说明');
    await ensureClassificationRoot(rootId);
    const sync = new CategoryIndexMaintenance(() => ({ rootDocumentId: rootId, autoCreateIndex: false }), error => errors.push(error));
    const errors: unknown[] = [], events: string[] = [];
    const url = new URL(base!); url.protocol = 'ws:'; url.pathname = '/ws'; url.search = `?app=noosphere-test&id=attrs-${Date.now()}&type=main`;
    const socket = new WebSocket(url);
    socket.addEventListener('message', message => { const detail = JSON.parse(String(message.data)); events.push(detail.cmd); sync.onMessage({ detail }); });
    const content = async (): Promise<string> => (await kernelPost<{ kramdown: string }>('/api/block/getBlockKramdown', { id: rootId })).kramdown;
    try {
      await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true }); });
      const doc = await create('/标记变更根/自定义分类', '用户手动建立的分类');
      await vi.waitFor(async () => expect(await content(), events.join(',')).toContain(doc), { timeout: 8000 });
      await attrs(doc, { 'custom-zl-category': 'true' });
      expect((await discoverCategories(rootId)).map(node => node.id)).toContain(doc);
      await vi.waitFor(async () => expect((await content()).split('\n').find(line => line.includes(`((${doc} '`))).toContain('📚'), { timeout: 8000 });
      await attrs(doc, { 'custom-zl-category': '' });
      expect((await discoverCategories(rootId)).map(node => node.id)).not.toContain(doc);
      expect(await content()).toContain(doc);
      await vi.waitFor(async () => expect((await content()).split('\n').find(line => line.includes(`((${doc} '`))).toContain('📄'), { timeout: 8000 });
      const child = await create('/标记变更根/自定义分类/未标记的中间层/普通文章', '普通文档也进入根目录');
      await vi.waitFor(async () => expect(await content()).toContain(child), { timeout: 8000 });
      expect(await content()).toContain('未标记的中间层');
      await kernelPost('/api/filetree/renameDocByID', { id: child, title: '普通文章改名' });
      await vi.waitFor(async () => expect(await content()).toContain('普通文章改名'), { timeout: 8000 });
      await kernelPost('/api/filetree/moveDocsByID', { fromIDs: [doc], toID: outside });
      await vi.waitFor(async () => { expect(await content()).not.toContain(doc); expect(await content()).not.toContain(child); }, { timeout: 8000 });
      await kernelPost('/api/filetree/moveDocsByID', { fromIDs: [doc], toID: rootId });
      await vi.waitFor(async () => expect(await content()).toContain(child), { timeout: 8000 });
      await kernelPost('/api/filetree/removeDocByID', { id: doc });
      await vi.waitFor(async () => expect(await content()).not.toContain(doc), { timeout: 8000 });
      expect(errors).toEqual([]);
    } finally { sync.stop(); socket.close(); }
  }, 30000);
});

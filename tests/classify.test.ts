// @vitest-environment jsdom
/** 使用与内核一致的数据形状验证分类范围、来源身份与受管目录。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attrFromIal, categoryDescription, classificationCandidates, descriptionFromMarkdown, discoverCategories, refreshCategoryIndex, renderCategoryIndex } from "../src/siyuan/tree";
import { classifyArticle, CLASSIFY_CONFIDENCE } from "../src/review/classify";
import { articleIdentity, ensureArticleDocument, findArticleDocument, safeDocumentTitle } from "../src/siyuan/destination";
import { locateDocument, withinRoot, type DocumentLocation } from "../src/siyuan/location";
import { kernelPost, proxyRequest } from "../src/siyuan/api";
import { DEFAULT_SETTINGS } from "../src/types";

vi.mock("../src/siyuan/api", () => ({ kernelPost: vi.fn(), proxyRequest: vi.fn() }));
const box = "20260101000000-0000000", rootId = "20260101000000-aaaaaaa", ai = "20260101000000-bbbbbbb", llm = "20260101000000-ccccccc", outside = "20260101000000-ddddddd", saved = "20260101000000-eeeeeee", index = "20260101000000-fffffff";
const root: DocumentLocation = { id: rootId, notebook: box, path: `/${rootId}.sy`, hpath: "/知流", isNotebook: false };
const locations: Record<string, DocumentLocation> = {
  [rootId]: root,
  [ai]: { ...root, id: ai, path: `/${rootId}/${ai}.sy`, hpath: "/知流/AI" },
  [llm]: { ...root, id: llm, path: `/${rootId}/${ai}/${llm}.sy`, hpath: "/知流/AI/大模型" },
  [outside]: { ...root, id: outside, path: `/${outside}.sy`, hpath: "/范围外" },
  [saved]: { ...root, id: saved, path: `/${rootId}/${ai}/${saved}.sy`, hpath: "/知流/AI/文章标题" },
};
const article = { title: "文章标题", url: "https://example.com/post?a=1&b=2", markdown: "正文" };
const settings = { ...DEFAULT_SETTINGS, modelKey: "k", modelName: "m", modelBaseUrl: "https://example.com/v1" };
const calls = (): Array<[string, unknown]> => vi.mocked(kernelPost).mock.calls;
let override: (path: string, payload: any) => unknown;
function row(id: string, extra = ' custom-zl-desc="分类介绍"') {
  const loc = locations[id];
  return { id, box: loc.notebook, path: loc.path, hpath: loc.hpath, parent_id: "", content: loc.hpath.split('/').at(-1), ial: `{: custom-zl-category="true"${extra}}`, type: "d" };
}
beforeEach(() => {
  vi.resetAllMocks(); override = () => undefined;
  vi.mocked(kernelPost).mockImplementation(async (path, payload: any) => {
    const value = override(path, payload); if (value !== undefined) return value;
    if (path === "/api/notebook/lsNotebooks") return { notebooks: [{ id: box }] };
    if (path === "/api/attr/getBlockAttrs") return { type: "doc" };
    if (path === "/api/filetree/getPathByID") return { notebook: locations[payload.id].notebook, path: locations[payload.id].path };
    if (path === "/api/filetree/getHPathByID") return locations[payload.id].hpath;
    if (path === "/api/block/getBlockKramdown") return { id: payload.id, kramdown: '# 标题\n\n正文分类介绍\n{: id="x"}' };
    if (path === "/api/query/sql" || path === "/api/filetree/getIDsByHPath") return [];
    if (path === "/api/filetree/createDocWithMd") return saved;
    if (path === "/api/block/updateBlock") return [{ doOperations: [{ id: payload.id, action: "update" }] }];
    if (path === "/api/block/appendBlock") return [{ doOperations: [{ id: index, action: "insert" }] }];
    if (path === "/api/filetree/listDocsByPath") return { files: [{ id: saved, name: '文章标题.sy' }] };
    if (path === "/api/attr/setBlockAttrs" || path === "/api/sqlite/flushTransaction" || path === "/api/filetree/renameDocByID") return null;
    throw new Error(`unexpected ${path}`);
  });
});

describe("category discovery", () => {
  it("matches complete IAL attribute names and decodes entities", () => {
    expect(attrFromIal('{: custom-zl-desc="AI &amp; 工具"}', 'custom-zl-desc')).toBe("AI & 工具");
    expect(attrFromIal('{: not-custom-zl-category="true"}', 'custom-zl-category')).toBe("");
  });
  it("skips IAL, headings, YAML and managed lists when reading an introduction", () => {
    expect(descriptionFromMarkdown('---\ntitle: x\n---\n\n# 标题\n{: id="x"}\n\n这是介绍。\n{: id="y"}\n\n* [目录](siyuan://blocks/x)')).toBe("这是介绍。");
    expect(descriptionFromMarkdown('# 标题\n\n* [目录](siyuan://blocks/x)')).toBe("");
  });
  it("reads the actual getBlockKramdown object response", async () => {
    expect(await categoryDescription(ai, "")).toBe("正文分类介绍");
  });
  it("only includes categories in the anchor's ID path and notebook", async () => {
    override = path => path === "/api/query/sql" ? [row(ai), row(llm), row(outside), { ...row(ai), id: outside, box: 'another-notebook' }] : undefined;
    const result = await discoverCategories(rootId);
    expect(result.map(item => item.id)).toEqual([ai, llm]);
    expect(result[1]).toMatchObject({ path: "AI / 大模型", parentId: ai });
    const stmt = calls().find(([path]) => path === "/api/query/sql")![1] as { stmt: string };
    expect(stmt.stmt).toContain(`box = '${box}'`); expect(stmt.stmt).toContain(`path LIKE '/${rootId}/%'`);
  });
  it("keeps unmarked intermediate folders in full paths", async () => {
    override = path => path === "/api/query/sql" ? [{ ...row(llm), hpath: '/知流/AI/中间目录/大模型' }] : undefined;
    expect((await discoverCategories(root))[0].path).toBe("AI / 中间目录 / 大模型");
  });
  it("reads body descriptions when no attribute override exists", async () => {
    override = path => path === "/api/query/sql" ? [row(ai, '')] : undefined;
    expect(classificationCandidates(await discoverCategories(root))[0].description).toBe("正文分类介绍");
  });
  it("uses the explicit description without reading the body", async () => {
    override = path => path === "/api/query/sql" ? [row(ai)] : undefined;
    expect((await discoverCategories(root))[0].description).toBe("分类介绍");
    expect(calls().some(([path]) => path === "/api/block/getBlockKramdown")).toBe(false);
  });
  it("supports a notebook anchor without admitting another notebook", async () => {
    override = path => path === "/api/query/sql" ? [row(ai), row(outside), { ...row(llm), box: 'other' }] : undefined;
    expect((await discoverCategories(box)).map(item => item.id).sort()).toEqual([ai, outside].sort());
  });
  it("does not trust SQL LIKE matches or accept the anchor itself", async () => {
    override = path => path === "/api/query/sql" ? [{ ...row(ai), ial: 'not-custom-zl-category="true"' }, row(rootId)] : undefined;
    expect(await discoverCategories(root)).toEqual([]);
  });
  it("rejects body blocks and invalid IDs as anchors", async () => {
    await expect(locateDocument("invalid")).rejects.toThrow("有效");
    override = path => path === "/api/attr/getBlockAttrs" ? { type: 'p' } : undefined;
    await expect(locateDocument(ai)).rejects.toThrow("正文块");
  });
  it("checks path segment boundaries instead of human title prefixes", () => {
    expect(withinRoot(locations[ai], root)).toBe(true);
    expect(withinRoot(root, root)).toBe(false);
    expect(withinRoot(root, root, true)).toBe(true);
    expect(withinRoot({ notebook: box, path: `/${rootId}x/${ai}.sy` }, root)).toBe(false);
  });
});

describe("classification protocols", () => {
  const categories = [{ id: ai, name: 'AI', description: 'AI 文章', path: 'AI', parentId: rootId }];
  const decision = (id: string | null, confidence = 0.84) => JSON.stringify({ collection_id: id, confidence, reason: '主题匹配' });
  function respond(text: string): void {
    vi.mocked(proxyRequest).mockResolvedValue({ body: JSON.stringify({ choices: [{ message: { content: text } }] }), status: 200, contentType: 'application/json' });
  }
  it("does not call a model without categories", async () => {
    expect((await classifyArticle('标题', '正文', [], settings)).categoryId).toBeNull(); expect(proxyRequest).not.toHaveBeenCalled();
  });
  it("accepts a known ID at the exact threshold", async () => {
    respond(decision(ai, CLASSIFY_CONFIDENCE));
    expect((await classifyArticle('标题', '正文', categories, settings)).categoryId).toBe(ai);
  });
  it("falls back for low confidence and fabricated IDs", async () => {
    respond(decision(ai, 0.59)); expect((await classifyArticle('标题', '正文', categories, settings)).categoryId).toBeNull();
    respond(decision(outside)); expect((await classifyArticle('标题', '正文', categories, settings)).categoryId).toBeNull();
  });
  it("rejects malformed results", async () => {
    respond('无 JSON'); await expect(classifyArticle('标题', '正文', categories, settings)).rejects.toThrow('JSON');
  });
  it.each([
    ['openai_chat', { choices: [{ message: { content: decision(ai) } }] }],
    ['openai_responses', { output: [{ content: [{ type: 'output_text', text: decision(ai) }] }] }],
    ['anthropic', { content: [{ type: 'text', text: decision(ai) }] }],
    ['google', { candidates: [{ content: { parts: [{ text: decision(ai) }] } }] }],
  ] as const)("uses the configured %s protocol", async (modelFormat, body) => {
    vi.mocked(proxyRequest).mockResolvedValue({ body: JSON.stringify(body), status: 200, contentType: 'application/json' });
    expect((await classifyArticle('标题', '正文', categories, { ...settings, modelFormat })).categoryId).toBe(ai);
    expect(JSON.stringify(vi.mocked(proxyRequest).mock.calls[0][3])).toContain('AI 文章');
  });
});

describe("source-based article saves", () => {
  it("normalizes URL fragments and preserves source query parameters", () => {
    expect(articleIdentity({ url: article.url+'#section' })).toBe(articleIdentity(article));
    expect(articleIdentity({ url: 'https://example.com/post?a=2' })).not.toBe(articleIdentity(article));
    expect(safeDocumentTitle(' A/B: "C" ')).toBe('A／B： ＂C＂');
  });
  it("creates a document and marks its source", async () => {
    expect(await ensureArticleDocument(ai, article, '# 文章标题\n\n正文', { root })).toEqual({ documentId: saved, created: true, parentId: ai });
    expect(calls().find(([p]) => p === '/api/filetree/createDocWithMd')![1]).toMatchObject({ notebook: box, path: '/知流/AI/文章标题', markdown: expect.stringContaining('正文') });
    expect(calls().find(([p]) => p === '/api/attr/setBlockAttrs')![1]).toMatchObject({ attrs: { 'custom-zl-article': articleIdentity(article) } });
  });
  it("never overwrites a same-title unrelated note", async () => {
    override = (path, payload) => path === '/api/filetree/getIDsByHPath' ? (payload.path.endsWith('（2）') ? [] : [outside]) : undefined;
    await ensureArticleDocument(ai, article, '正文', { root });
    expect(calls().find(([p]) => p === '/api/filetree/createDocWithMd')![1]).toMatchObject({ path: '/知流/AI/文章标题（2）' });
    expect(calls().some(([p]) => p === '/api/block/updateBlock')).toBe(false);
  });
  it("finds the same source anywhere under the anchor after a title change", async () => {
    override = path => path === '/api/query/sql' ? [{ id: saved, box, path: locations[saved].path }] : undefined;
    expect(await ensureArticleDocument(llm, { ...article, title: '新标题' }, '更新正文', { root })).toEqual({ documentId: saved, created: false, parentId: ai });
    expect(calls().some(([p]) => p === '/api/filetree/createDocWithMd')).toBe(false);
    expect(calls().find(([p]) => p === '/api/filetree/renameDocByID')![1]).toEqual({ id: saved, title: '新标题' });
  });
  it("can retry a bound document if marking it previously failed", async () => {
    expect(await ensureArticleDocument(ai, article, '更新正文', { root, existingId: saved })).toMatchObject({ created: false, documentId: saved });
  });
  it("preserves native formatting and remaps internal block references", async () => {
    let sequence = 0;
    Object.assign(window, { Lute: { New: () => ({ Md2BlockDOM: () => '<div data-type="NodeParagraph" data-node-id="meta">来源</div>' }), NewNodeID: () => `import-${++sequence}` } });
    const blockDOM = '<div data-type="NodeHeading" data-node-id="heading">标题</div><div data-type="NodeParagraph" data-node-id="body"><span style="color:red">彩色文字</span><span data-type="block-ref" data-id="body">内部引用</span></div>';
    await ensureArticleDocument(ai, article, '正文', { root, blockDOM });
    const written = calls().find(([p]) => p === '/api/block/updateBlock')![1] as { dataType: string; data: string };
    expect(written.dataType).toBe('dom'); expect(written.data).toContain('color:red');
    expect(written.data).not.toContain('data-node-id="body"');
    expect(written.data).toContain('data-id="import-2"');
  });
  it("records a newly created document before later steps fail", async () => {
    const onCreated = vi.fn();
    override = path => { if (path === '/api/attr/setBlockAttrs') throw new Error('属性写入失败'); };
    await expect(ensureArticleDocument(ai, article, '正文', { root, onCreated })).rejects.toThrow('属性写入失败');
    expect(onCreated).toHaveBeenCalledWith(saved, ai);
  });
  it("rejects an outside destination or changed source binding", async () => {
    await expect(ensureArticleDocument(outside, article, '正文', { root })).rejects.toThrow('不在所选锚点下');
    override = path => path === '/api/attr/getBlockAttrs' ? { type: 'doc', 'custom-zl-article': 'other-source' } : undefined;
    await expect(findArticleDocument(root, article, saved)).rejects.toThrow('来源标记');
  });
  it("serializes concurrent saves of the same source", async () => {
    let created = false;
    override = path => {
      if (path === '/api/query/sql') return created ? [{ id: saved, box, path: locations[saved].path }] : [];
      if (path === '/api/attr/setBlockAttrs') { created = true; return null; }
    };
    const results = await Promise.all([ensureArticleDocument(ai, article, '正文', { root }), ensureArticleDocument(ai, article, '正文', { root })]);
    expect(results.map(x => x.documentId)).toEqual([saved, saved]);
    expect(calls().filter(([p]) => p === '/api/filetree/createDocWithMd')).toHaveLength(1);
  });
});

describe("managed category indexes", () => {
  const marker = { id: index, type: 'l', ial: '{: custom-zl-index="true"}' };
  it("escapes article titles in block links", () => {
    expect(renderCategoryIndex([{ id: ai, title: 'A *B* [C]' }])).toBe(`* [A \\*B\\* \\[C\\]](siyuan://blocks/${ai})`);
  });
  it("uses the file tree API and rewrites only a marked content block", async () => {
    override = path => path === '/api/query/sql' ? [marker] : undefined;
    expect(await refreshCategoryIndex(ai)).toBe(index);
    expect(calls().find(([p]) => p === '/api/block/updateBlock')![1]).toEqual({ id: index, dataType: 'markdown', data: `* [文章标题](siyuan://blocks/${saved})` });
    expect(calls().some(([p]) => p === '/api/block/getChildBlocks')).toBe(false);
  });
  it("does not create a directory without opt-in", async () => {
    expect(await refreshCategoryIndex(ai)).toBeNull(); expect(calls().some(([p]) => p === '/api/block/appendBlock')).toBe(false);
  });
  it("creates a managed block after opt-in", async () => {
    expect(await refreshCategoryIndex(ai, { create: true })).toBe(index);
    expect(calls().find(([p]) => p === '/api/block/appendBlock')![1]).toMatchObject({ parentID: ai });
    expect(calls().filter(([p]) => p === '/api/attr/setBlockAttrs').map(([, payload]) => payload)).toContainEqual({ id: ai, attrs: { 'custom-sy-readonly': 'true' } });
  });
  it("defaults an existing managed index page to read-only", async () => {
    override = path => path === '/api/query/sql' ? [marker] : undefined;
    await refreshCategoryIndex(ai);
    expect(calls()).toContainEqual(['/api/attr/setBlockAttrs', { id: ai, attrs: { 'custom-sy-readonly': 'true' } }]);
  });
  it.each(['false', 'true'])("preserves an explicit document lock value of %s", async value => {
    override = path => path === '/api/query/sql' ? [marker] : path === '/api/attr/getBlockAttrs' ? { type: 'doc', 'custom-sy-readonly': value } : undefined;
    await refreshCategoryIndex(ai);
    expect(calls().filter(([p, payload]) => p === '/api/attr/setBlockAttrs' && (payload as any).id === ai)).toHaveLength(0);
  });
  it("clears stale entries when the category becomes empty", async () => {
    override = path => path === '/api/query/sql' ? [marker] : path === '/api/filetree/listDocsByPath' ? { files: [] } : undefined;
    await refreshCategoryIndex(ai);
    expect(calls().find(([p]) => p === '/api/block/updateBlock')![1]).toMatchObject({ data: '暂无子文档。' });
  });
  it("ignores markers with only a similar attribute name", async () => {
    override = path => path === '/api/query/sql' ? [{ ...marker, ial: 'not-custom-zl-index="true"' }] : undefined;
    expect(await refreshCategoryIndex(ai)).toBeNull();
  });
});

/** 从锚点下发现分类，并维护介绍下方的受管目录块。 */
import { kernelPost } from "./api";
import { locateDocument, parentDocumentId, rootCondition, SIYUAN_ID, sqlLiteral, withinRoot, type DocumentLocation } from "./location";

export const CATEGORY_ATTR = "custom-zl-category";
export const INDEX_ATTR = "custom-zl-index";
export interface CategoryNode { id: string; name: string; description: string; path: string; parentId: string }
interface SqlRow { id: string; box: string; path: string; hpath: string; content: string; ial: string; type: string }

function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}

/** 匹配完整属性名，避免说明文字或相似属性名命中 LIKE 后被误认。 */
export function attrFromIal(ial: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matched = ial.match(new RegExp(`(?:^|\\s)${escaped}="((?:[^"\\\\]|\\\\.)*)"`));
  return matched ? unescapeHtml(matched[1].replace(/\\(.)/g, "$1")) : "";
}

/** 跳过文档属性、标题和自动目录，提取首个介绍段落。 */
export function descriptionFromMarkdown(markdown: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/^\s*\{:[^\n]*\}\s*$/gm, "");
  const first = body.split(/\n\s*\n/).map(block => block.trim()).find(block => block
    && !/^(---|\*\*\*|___)$/.test(block) && !/^#{1,6}\s+/.test(block)
    && !/^(?:[*+-]|\d+\.)\s|^```|^~~~|^\{\{/.test(block));
  return first ? first.replace(/^>\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 2000) : "";
}

/** getBlockKramdown 的 data 是对象，不能作为 Markdown 字符串读取。 */
export async function categoryDescription(documentId: string, known: string, signal?: AbortSignal): Promise<string> {
  if (known.trim()) return known.trim();
  const result = await kernelPost<{ id: string; kramdown: string }>("/api/block/getBlockKramdown", { id: documentId }, undefined, signal);
  return descriptionFromMarkdown(result.kramdown);
}

/** 用 box/path 限定真实子树，用 hpath 保留包括未标记中间目录在内的完整分类路径。 */
export async function discoverCategories(anchor: string | DocumentLocation, signal?: AbortSignal): Promise<CategoryNode[]> {
  const root = typeof anchor === "string" ? await locateDocument(anchor, signal) : anchor;
  // 属性更新与 SQL 索引异步提交，先同步队列再读取最新分类。
  await kernelPost("/api/sqlite/flushTransaction", {}, undefined, signal);
  const rows = await kernelPost<SqlRow[]>("/api/query/sql", {
    stmt: `SELECT id, box, path, hpath, content, ial, type FROM blocks WHERE type = 'd' AND ${rootCondition(root)} AND ial LIKE '%${CATEGORY_ATTR}%' ORDER BY hpath LIMIT 2147483647`,
  }, undefined, signal);
  const nodes: CategoryNode[] = [];
  for (const row of rows) {
    if (row.id === root.id || !SIYUAN_ID.test(row.id) || row.type !== "d" || !withinRoot({ notebook: row.box, path: row.path }, root) || !attrFromIal(row.ial, CATEGORY_ATTR)) continue;
    const relative = unescapeHtml(row.hpath).slice(root.hpath.length).replace(/^\//, "");
    nodes.push({ id: row.id, name: unescapeHtml(row.content).trim(),
      path: relative.split("/").filter(Boolean).join(" / "), parentId: parentDocumentId({ notebook: row.box, path: row.path }),
      description: await categoryDescription(row.id, attrFromIal(row.ial, "custom-zl-desc"), signal) });
  }
  return nodes.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
}

export function classificationCandidates(nodes: CategoryNode[]): Array<{ id: string; path: string; description: string }> {
  return nodes.filter(node => node.name && node.id).map(node => ({ id: node.id, path: node.path || node.name, description: node.description }));
}

export interface CategoryIndexItem { id: string; title: string }
export function renderCategoryIndex(items: CategoryIndexItem[]): string {
  return items.filter(item => item.id && item.title).map(item => `* [${item.title.replace(/([\\`*_{}\[\]()#+.!>|-])/g, "\\$1")}](siyuan://blocks/${item.id})`).join("\n");
}

const indexUpdates = new Map<string, Promise<string | null>>();

/** 同一分类串行刷新，避免打开文档与保存文章同时写回旧目录。 */
export async function refreshCategoryIndex(categoryDocId: string, options: { create?: boolean } = {}): Promise<string | null> {
  if (!SIYUAN_ID.test(categoryDocId)) throw new Error("请输入有效的思源文档 ID");
  const previous = indexUpdates.get(categoryDocId);
  const pending = (async () => { if (previous) await previous.catch(() => undefined); return updateCategoryIndex(categoryDocId, !!options.create); })();
  indexUpdates.set(categoryDocId, pending);
  try { return await pending; } finally { if (indexUpdates.get(categoryDocId) === pending) indexUpdates.delete(categoryDocId); }
}

/** 列举文档树而非正文块；只在用户启用创建时追加一个受管块。 */
async function updateCategoryIndex(categoryDocId: string, create: boolean): Promise<string | null> {
  await kernelPost("/api/sqlite/flushTransaction", {});
  const rows = await kernelPost<SqlRow[]>("/api/query/sql", {
    stmt: `SELECT id, ial, type FROM blocks WHERE root_id = ${sqlLiteral(categoryDocId)} AND type != 'd' AND ial LIKE '%${INDEX_ATTR}%' ORDER BY updated DESC LIMIT 100`,
  });
  const block = rows.find(row => attrFromIal(row.ial, INDEX_ATTR));
  if (!block && !create) return null;
  const location = await locateDocument(categoryDocId);
  const children = await kernelPost<{ files: Array<{ id: string; name: string }> }>("/api/filetree/listDocsByPath", {
    notebook: location.notebook, path: location.path, maxListCount: 0,
  });
  const data = renderCategoryIndex(children.files.map(child => ({ id: child.id, title: child.name.replace(/\.sy$/, "") }))) || "暂无子文档。";
  let id = block?.id;
  if (id) await kernelPost("/api/block/updateBlock", { id, dataType: "markdown", data });
  else {
    const result = await kernelPost<Array<{ doOperations?: Array<{ id?: string; action?: string }> }>>("/api/block/appendBlock", { parentID: categoryDocId, dataType: "markdown", data });
    id = result.flatMap(item => item.doOperations || []).find(op => op.id && op.action !== "delete")?.id;
    if (!id) throw new Error("思源未确认目录块创建结果");
  }
  await kernelPost("/api/attr/setBlockAttrs", { id, attrs: { [INDEX_ATTR]: "true" } });
  return id;
}

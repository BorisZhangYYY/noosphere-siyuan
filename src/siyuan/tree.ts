/** 从锚点下发现分类，并维护介绍下方的受管目录块。 */
import { kernelPost } from "./api";
import { locateDocument, parentDocumentId, rootCondition, SIYUAN_ID, sqlLiteral, withinRoot, type DocumentLocation } from "./location";
import { readCategoryDescription } from "./category-description";

export const CATEGORY_ATTR = "custom-zl-category";
export const INDEX_ATTR = "custom-zl-index";
export const INDEX_ENABLED_ATTR = "custom-zl-index-enabled";
const INDEX_SIGNATURE_ATTR = "custom-zl-index-signature";
export const READONLY_ATTR = "custom-sy-readonly";
export const OVERVIEW_ROOT_ATTR = "custom-zl-overview-root";
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
  return readCategoryDescription(markdown);
}

/** getBlockKramdown 的 data 是对象，不能作为 Markdown 字符串读取。 */
export async function categoryDescription(documentId: string, known: string, signal?: AbortSignal): Promise<string> {
  const result = await kernelPost<{ id: string; kramdown: string }>("/api/block/getBlockKramdown", { id: documentId }, undefined, signal);
  return readCategoryDescription(result.kramdown, known);
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

export interface CategoryIndexItem { id: string; title: string; isIndex?: boolean; children?: CategoryIndexItem[] }
/** 索引页加粗并标为书册，内容页标为单页；标题仍使用原生动态块引用。 */
export function renderCategoryIndex(items: CategoryIndexItem[], depth = 0): string {
  const html = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return items.filter(item => SIYUAN_ID.test(item.id) && item.title).map(item => {
    // 加粗作为原生文本标记与引用共存，避免 HTML strong 包裹时丢失动态引用。
    const reference = `<span data-type="${item.isIndex ? "block-ref strong" : "block-ref"}" data-id="${item.id}" data-subtype="d">${html(item.title)}</span>`;
    return `${"    ".repeat(depth)}* ${item.isIndex ? "📚" : "📄"} ${reference}`
      + (item.children?.length ? `\n${renderCategoryIndex(item.children, depth + 1)}` : "");
  }).join("\n");
}

/** 批量读取稳定标记，普通文章即使有子文档也不会因此被误认成索引页。 */
async function indexDocuments(root: DocumentLocation): Promise<Set<string>> {
  const rows = await kernelPost<Array<{ id: string; root_id: string; type: string; ial: string }>>("/api/query/sql", {
    stmt: `SELECT id, root_id, type, ial FROM blocks WHERE ${rootCondition(root)} AND ((type = 'd' AND (ial LIKE '%${CATEGORY_ATTR}%' OR ial LIKE '%${INDEX_ENABLED_ATTR}%' OR ial LIKE '%${OVERVIEW_ROOT_ATTR}%')) OR (type != 'd' AND ial LIKE '%${INDEX_ATTR}%')) LIMIT 2147483647`,
  });
  return new Set(rows.filter(row => row.type === "d"
    ? !!attrFromIal(row.ial, CATEGORY_ATTR) || attrFromIal(row.ial, INDEX_ENABLED_ATTR) === "true" || !!attrFromIal(row.ial, OVERVIEW_ROOT_ATTR)
    : !!attrFromIal(row.ial, INDEX_ATTR))
    .map(row => row.type === "d" ? row.id : row.root_id).filter(id => SIYUAN_ID.test(id)));
}

/** 沿思源真实文档树递归，保留目录排序、全部层级，并拒绝重复节点。 */
async function indexItems(location: DocumentLocation, indexes: Set<string>, visited = new Set<string>()): Promise<CategoryIndexItem[]> {
  if (visited.has(location.id)) return [];
  visited.add(location.id);
  const result = await kernelPost<{ files: Array<{ id: string; name: string; path?: string; subFileCount?: number }> }>("/api/filetree/listDocsByPath", {
    notebook: location.notebook, path: location.path, maxListCount: 0,
  });
  const items: CategoryIndexItem[] = [];
  for (const child of result.files) {
    if (!SIYUAN_ID.test(child.id) || visited.has(child.id)) continue;
    const parentPath = location.isNotebook ? "" : location.path.replace(/\.sy$/, "");
    const childPath = child.path || `${parentPath}/${child.id}.sy`;
    if (!withinRoot({ notebook: location.notebook, path: childPath }, location)) continue;
    items.push({ id: child.id, title: child.name.replace(/\.sy$/, ""), isIndex: indexes.has(child.id), children: (child.subFileCount ?? 0) > 0
      ? await indexItems({ ...location, id: child.id, path: childPath, isNotebook: false }, indexes, visited) : [] });
  }
  return items;
}

/** 非安全用途的内容签名，仅用于避免无变化的目录反复写入与触发界面重载。 */
function indexSignature(items: CategoryIndexItem[]): string {
  let hash = 2166136261;
  for (const character of JSON.stringify(items)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}
function itemIds(items: CategoryIndexItem[]): string[] { return items.flatMap(item => [item.id, ...itemIds(item.children || [])]); }

const indexUpdates = new Map<string, Promise<string | null>>();

/** 同一分类串行刷新，避免打开文档与保存文章同时写回旧目录。 */
export async function refreshCategoryIndex(categoryDocId: string, options: { create?: boolean } = {}): Promise<string | null> {
  if (!SIYUAN_ID.test(categoryDocId)) throw new Error("请输入有效的思源文档 ID");
  const previous = indexUpdates.get(categoryDocId);
  const pending = (async () => { if (previous) await previous.catch(() => undefined); return updateCategoryIndex(categoryDocId, !!options.create); })();
  indexUpdates.set(categoryDocId, pending);
  try { return await pending; } finally { if (indexUpdates.get(categoryDocId) === pending) indexUpdates.delete(categoryDocId); }
}

/** 递归维护受管块；无变化不重写，目录被删后按文档上的启用标记恢复。 */
async function updateCategoryIndex(categoryDocId: string, create: boolean): Promise<string | null> {
  await kernelPost("/api/sqlite/flushTransaction", {});
  const rows = await kernelPost<SqlRow[]>("/api/query/sql", {
    stmt: `SELECT id, ial, type FROM blocks WHERE root_id = ${sqlLiteral(categoryDocId)} AND type != 'd' AND ial LIKE '%${INDEX_ATTR}%' ORDER BY updated DESC LIMIT 100`,
  });
  const block = rows.find(row => attrFromIal(row.ial, INDEX_ATTR));
  const attrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id: categoryDocId });
  if (!block && !create && attrs[INDEX_ENABLED_ATTR] !== "true") return null;
  // 根目录与分类页都展示真实的完整文档树；分类候选仍由 discoverCategories 独立筛选。
  // 保留旧根绑定的读取，兼容已有受管目录，刷新时直接替换原目录块。
  const location = await locateDocument(attrs[OVERVIEW_ROOT_ATTR] || categoryDocId);
  const items = await indexItems(location, await indexDocuments(location));
  const emptyText = "暂无子文档。";
  const data = renderCategoryIndex(items) || emptyText;
  const signature = indexSignature(items);
  const docAttrs: Record<string, string> = {};
  if (attrs[INDEX_ENABLED_ATTR] !== "true") docAttrs[INDEX_ENABLED_ATTR] = "true";
  // 明确解锁后的 false 必须保留；文章文档不参与锁定。
  if (!attrs[READONLY_ATTR]) docAttrs[READONLY_ATTR] = "true";
  let id = block?.id;
  if (id && attrFromIal(block!.ial, INDEX_SIGNATURE_ATTR) === signature) {
    const current = await kernelPost<{ kramdown: string }>("/api/block/getBlockKramdown", { id });
    const references = Array.from(current.kramdown.matchAll(/\(\((\d{14}-[a-z0-9]{7})[\s)]/g), match => match[1]);
    if (JSON.stringify(references) === JSON.stringify(itemIds(items)) && (items.length || current.kramdown.includes(emptyText))) {
      if (Object.keys(docAttrs).length) await kernelPost("/api/attr/setBlockAttrs", { id: categoryDocId, attrs: docAttrs });
      return id;
    }
  }
  if (id) await kernelPost("/api/block/updateBlock", { id, dataType: "markdown", data });
  else {
    const result = await kernelPost<Array<{ doOperations?: Array<{ id?: string; action?: string }> }>>("/api/block/appendBlock", { parentID: categoryDocId, dataType: "markdown", data });
    id = result.flatMap(item => item.doOperations || []).find(op => op.id && op.action !== "delete")?.id;
    if (!id) throw new Error("思源未确认目录块创建结果");
  }
  await kernelPost("/api/attr/setBlockAttrs", { id, attrs: { [INDEX_ATTR]: "true", [INDEX_SIGNATURE_ATTR]: signature } });
  if (Object.keys(docAttrs).length) await kernelPost("/api/attr/setBlockAttrs", { id: categoryDocId, attrs: docAttrs });
  return id;
}

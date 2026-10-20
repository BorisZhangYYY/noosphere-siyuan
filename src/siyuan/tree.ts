/**
 * 分类树与落库目标：发现带 custom-zl-category 的分类文档、按标题定位/新建文章文档、
 * 维护分类文档里的自动目录块。所有调用都走思源内核 API，不缓存 ID，随文档移动自动跟随。
 */
import { kernelPost } from "./api";

/** 分类文档与目录块使用的自定义属性名；目录插件用 custom-index-create，这里独立命名避免互相覆盖。 */
export const CATEGORY_ATTR = "custom-zl-category";
export const ROOT_ATTR = "custom-zl-root";
export const INDEX_ATTR = "custom-zl-index";

export interface CategoryNode {
  id: string;
  name: string;
  description: string;
  /** 从根分类开始的完整路径，用 " / " 连接，供分类提示词使用。 */
  path: string;
  parentId: string;
}

interface SqlRow { id: string; parent_id: string; content: string; ial: string; type: string }

/** 思源 SQL 只接受字面量，标识符一律走白名单校验后再拼接。 */
function assertDocumentId(id: string): string {
  if (!/^\d{14}-[a-z0-9]{7}$/.test(id)) throw new Error("请输入有效的思源文档 ID");
  return `'${id}'`;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

/** 从 IAL 中取出单个自定义属性；IAL 形如 `{: id="…" custom-zl-category="ai"}`。 */
export function attrFromIal(ial: string, name: string): string {
  const matched = ial.match(new RegExp(`${name}="((?:[^"\\\\]|\\\\.)*)"`));
  if (!matched) return "";
  return unescapeHtml(matched[1].replace(/\\(.)/g, "$1"));
}

/** 文档首段作为分类介绍；没有正文时返回空字符串，不阻断分类。 */
export function descriptionFromMarkdown(markdown: string): string {
  const first = markdown
    .split(/\n\s*\n/)
    .map(block => block.trim())
    // 标题和分隔线不承载介绍语义；文档首行标题不能被当成分类说明。
    .find(block => block && !/^(---|\*\*\*|___)$/.test(block) && !/^#{1,6}\s+/.test(block));
  if (!first) return "";
  return first.replace(/^>\s*/, "").replace(/\s+/g, " ").trim();
}

/**
 * 列出所有分类文档并按父子关系拼出完整路径。
 * 不依赖插件保存的 ID 列表：分类文档改名、移动、增删都会在下一次发现时反映出来。
 */
export async function discoverCategories(): Promise<CategoryNode[]> {
  const rows = await kernelPost<SqlRow[]>("/api/query/sql", {
    stmt: `SELECT id, parent_id, content, ial, type FROM blocks WHERE type = 'd' AND ial LIKE '%${CATEGORY_ATTR}%'`,
  });
  if (!Array.isArray(rows)) return [];
  const byId = new Map<string, { id: string; name: string; parentId: string; description: string; rawPath: string }>();
  for (const row of rows) {
    if (!row?.id || !attrFromIal(row.ial, CATEGORY_ATTR)) continue;
    byId.set(row.id, {
      id: row.id,
      name: unescapeHtml(row.content || "").trim(),
      parentId: row.parent_id || "",
      description: attrFromIal(row.ial, `custom-zl-desc`),
      rawPath: "",
    });
  }
  // 介绍优先用属性（设置时写入）；没有属性时再读正文首段，避免每条分类都发一次请求。
  const nodes: CategoryNode[] = [];
  for (const item of byId.values()) {
    const parts: string[] = [];
    const visited = new Set<string>();
    let cursor: { id: string; name: string } | undefined = item;
    while (cursor) {
      if (visited.has(cursor.id)) break;
      visited.add(cursor.id);
      parts.push(cursor.name);
      const parent = byId.get((cursor as { parentId?: string }).parentId || "");
      if (!parent) break;
      cursor = parent;
    }
    const ordered = parts.reverse().filter(Boolean);
    nodes.push({
      id: item.id,
      name: item.name,
      description: item.description,
      path: ordered.join(" / "),
      parentId: item.parentId,
    });
  }
  return nodes.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
}

/** 分类候选只包含有效路径；空路径退化为自身名称，保证模型拿到的 path 可用。 */
export function classificationCandidates(nodes: CategoryNode[]): Array<{ id: string; path: string; description: string }> {
  return nodes
    .filter(node => node.name && node.id)
    .map(node => ({ id: node.id, path: node.path || node.name, description: node.description }));
}

/** 读取文档正文用于补全缺失的介绍；单个分类失败不影响其他分类。 */
export async function categoryDescription(documentId: string, known: string): Promise<string> {
  if (known) return known;
  try {
    const markdown = await kernelPost<string>("/api/block/getBlockKramdown", { id: documentId });
    if (typeof markdown !== "string") return "";
    // getBlockKramdown 返回 kramdown 包裹的文档，取正文首个非标题块。
    const body = markdown.replace(/^---[\s\S]*?---/, "").replace(/^\s*\{\{[\s\S]*?\}\}\s*$/gm, "");
    return descriptionFromMarkdown(body);
  } catch { return ""; }
}

export interface CategoryIndexItem { id: string; title: string }

/** 目录项用思源块链接，标题中的特殊字符按 Markdown 语义转义，避免破坏列表结构。 */
export function renderCategoryIndex(items: CategoryIndexItem[]): string {
  const lines = items
    .filter(item => item.id && item.title)
    .map(item => `* [${item.title.replace(/([\\`*_{}\[\]()#+.!>|-])/g, "\\$1")}](siyuan://blocks/${item.id})`);
  return lines.join("\n");
}

/**
 * 重写分类文档内的目录块；目录块由属性 custom-zl-index 标记，找不到时返回 null 表示无需创建。
 * 只覆盖标记块，正文介绍与其他内容保持不动。
 */
export async function refreshCategoryIndex(categoryDocId: string): Promise<string | null> {
  const docId = assertDocumentId(categoryDocId);
  const rows = await kernelPost<SqlRow[]>("/api/query/sql", {
    stmt: `SELECT id, parent_id, content, ial, type FROM blocks WHERE root_id = ${docId} AND ial LIKE '%${INDEX_ATTR}%' ORDER BY updated DESC LIMIT 1`,
  });
  const block = Array.isArray(rows) ? rows[0] : undefined;
  if (!block?.id) return null;
  const children = await kernelPost<Array<{ id: string; type: string }>>("/api/block/getChildBlocks", { id: categoryDocId });
  const items = (Array.isArray(children) ? children : [])
    .filter(child => child.type === "d" && child.id !== categoryDocId)
    .map(child => ({ id: child.id, title: "" }));
  if (items.length) {
    const rowsById = await kernelPost<SqlRow[]>("/api/query/sql", {
      stmt: `SELECT id, content FROM blocks WHERE id IN (${items.map(item => `'${item.id}'`).join(",")})`,
    });
    const titles = new Map((Array.isArray(rowsById) ? rowsById : []).map(row => [row.id, unescapeHtml(row.content || "").trim()]));
    items.forEach(item => { item.title = titles.get(item.id) || ""; });
  }
  const data = renderCategoryIndex(items);
  if (!data.trim()) return block.id;
  await kernelPost("/api/block/updateBlock", { id: block.id, dataType: "markdown", data });
  return block.id;
}

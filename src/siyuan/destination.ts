/** 自动落库按来源识别文章；标题只用于命名，绝不据此覆盖已有笔记。 */
import { kernelPost } from "./api";
import { composeArticle } from "../article/compose";
import { composeBlockDOM } from "../article/editor";
import { locateDocument, parentDocumentId, rootCondition, sqlLiteral, withinRoot, type DocumentLocation } from "./location";
import type { Article } from "../types";
import type { Lute } from "siyuan";

export const ARTICLE_ATTR = "custom-zl-article";
export const SOURCE_ATTR = "custom-zl-source";
const FILENAME_CHARACTERS: Record<string, string> = {
  "/": "／", "\\": "＼", ":": "：", "*": "＊", "?": "？", '"': "＂", "<": "＜", ">": "＞", "|": "｜",
};
export function safeDocumentTitle(title: string): string {
  return title.replace(/\s+/g, " ").replace(/[\\/:*?"<>|]/g, character => FILENAME_CHARACTERS[character]).replace(/[\x00-\x1f\x7f]/g, "").trim();
}

/** URL 的片段不改变文章身份；编码后的键可直接存入属性索引，不受 IAL 实体转义影响。 */
export function articleIdentity(article: Pick<Article, "url">): string {
  const url = new URL(article.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("文章来源必须是网页链接");
  url.hash = "";
  return encodeURIComponent(url.href);
}

/** 已保存绑定仅来自本插件的自动落库记录；手动模式的 savedDocumentId 不能传入。 */
export async function findArticleDocument(root: DocumentLocation, article: Article, existingId?: string): Promise<DocumentLocation | null> {
  const identity = articleIdentity(article);
  if (existingId) {
    const location = await locateDocument(existingId);
    const attrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id: existingId });
    if (!withinRoot(location, root) || (attrs[ARTICLE_ATTR] && attrs[ARTICLE_ATTR] !== identity)) throw new Error("此前自动保存的文章已移出当前锚点或来源标记发生变化，请检查文档");
    return location;
  }
  // 刚保存的来源标记可能尚未进入 SQL 索引，必须同步写入队列后再查重。
  await kernelPost("/api/sqlite/flushTransaction", {});
  const rows = await kernelPost<Array<{ id: string; box: string; path: string }>>("/api/query/sql", {
    stmt: `SELECT b.id, b.box, b.path FROM blocks b JOIN attributes a ON a.block_id = b.id WHERE b.type = 'd' AND ${rootCondition(root, "b")} AND a.name = ${sqlLiteral(ARTICLE_ATTR)} AND a.value = ${sqlLiteral(identity)} LIMIT 2`,
  });
  if (rows.length > 1) throw new Error("锚点下有多篇同来源文章，请先确认要保留的文档");
  if (!rows.length) return null;
  const location = await locateDocument(rows[0].id);
  if (!withinRoot(location, root)) throw new Error("文章位置已变化，请重试");
  return location;
}

export interface EnsureArticleDocumentOptions {
  root: DocumentLocation;
  existingId?: string;
  blockDOM?: string;
  /** 新建后立即保留绑定，后续属性或原生格式写入失败也可重试同一文档。 */
  onCreated?: (documentId: string, parentId: string) => void;
}
export interface ArticleDocumentResult { documentId: string; created: boolean; parentId: string }
const articleWrites = new Map<string, Promise<ArticleDocumentResult>>();

/** 同一来源在当前前端串行写入；重试先找来源绑定，不再次分类或按标题覆盖。 */
export async function ensureArticleDocument(parentDocId: string, article: Article, markdown: string, options: EnsureArticleDocumentOptions): Promise<ArticleDocumentResult> {
  const key = `${options.root.id}:${articleIdentity(article)}`;
  const previous = articleWrites.get(key);
  const pending = (async () => { if (previous) await previous.catch(() => undefined); return writeArticleDocument(parentDocId, article, markdown, options); })();
  articleWrites.set(key, pending);
  try { return await pending; } finally { if (articleWrites.get(key) === pending) articleWrites.delete(key); }
}

/** 导入原生格式时分配新块 ID，并重写文章内部引用，避免与工作台或旧正文冲突。 */
function importBlockDOM(article: Article, blockDOM: string, documentId: string): string {
  const factory = (window as unknown as { Lute?: { New(): Lute; NewNodeID(): string } }).Lute;
  if (!factory) throw new Error("思源编辑组件未加载，请重启后重试保存");
  const container = document.createElement("div");
  container.innerHTML = composeBlockDOM(article, blockDOM, factory.New());
  const ids = new Map<string, string>();
  const heading = container.firstElementChild;
  if (heading?.getAttribute("data-type") === "NodeHeading") {
    const id = heading.getAttribute("data-node-id"); if (id) ids.set(id, documentId);
    heading.remove();
  }
  container.querySelectorAll<HTMLElement>("[data-node-id]").forEach(node => {
    const id = factory.NewNodeID(); ids.set(node.dataset.nodeId!, id); node.dataset.nodeId = id;
    node.removeAttribute("data-noosphere-metadata"); node.removeAttribute("data-readonly");
  });
  container.querySelectorAll<HTMLElement>('[data-type~="block-ref"][data-id]').forEach(node => {
    const id = ids.get(node.dataset.id!); if (id) node.dataset.id = id;
  });
  return container.innerHTML;
}

/** 同名冲突只调整名称；查找时允许命中正在更新的文章自身。 */
async function availableTitle(parent: DocumentLocation, title: string, existingId?: string): Promise<string> {
  let suffix = 1;
  while (true) {
    const candidate = suffix === 1 ? title : `${title}（${suffix}）`;
    const ids = await kernelPost<string[]>("/api/filetree/getIDsByHPath", { notebook: parent.notebook, path: `${parent.hpath}/${candidate}` });
    if (ids.every(id => id === existingId)) return candidate;
    suffix++;
  }
}

async function writeArticleDocument(parentDocId: string, article: Article, markdown: string, options: EnsureArticleDocumentOptions): Promise<ArticleDocumentResult> {
  const title = safeDocumentTitle(article.title);
  if (!title) throw new Error("文章标题为空，无法创建文档");
  const parent = await locateDocument(parentDocId);
  if (!withinRoot(parent, options.root, true)) throw new Error("分类位置不在所选锚点下，请重新分类");
  const existing = await findArticleDocument(options.root, article, options.existingId);
  // 文章标题由真正的文档标题承载，正文不再重复一级标题。
  const content = composeArticle(article, markdown).trim().replace(/^#{1,6}\s+[^\n]+\n+/, "");
  let documentId = existing?.id;
  const actualParent = existing ? parentDocumentId(existing) : parentDocId;
  if (!documentId) {
    const path = `${parent.hpath}/${await availableTitle(parent, title)}`;
    documentId = await kernelPost<string>("/api/filetree/createDocWithMd", { notebook: parent.notebook, path, markdown: content });
    if (!documentId) throw new Error("思源未返回新建文档 ID");
    options.onCreated?.(documentId, actualParent);
  }
  await kernelPost("/api/attr/setBlockAttrs", { id: documentId, attrs: { [ARTICLE_ATTR]: articleIdentity(article), [SOURCE_ATTR]: article.url } });
  if (existing || options.blockDOM) {
    const data = options.blockDOM ? importBlockDOM(article, options.blockDOM, documentId) : content;
    const result = await kernelPost<Array<{ doOperations?: Array<{ id?: string; action?: string }> }>>("/api/block/updateBlock", {
      id: documentId, dataType: options.blockDOM ? "dom" : "markdown", data,
    });
    if (!result.some(item => item.doOperations?.some(op => op.id && op.action !== "delete"))) throw new Error("思源未确认文章更新结果，请检查文档后重试");
  }
  if (existing) {
    const currentParent = actualParent === parent.id ? parent : await locateDocument(actualParent);
    const nextTitle = await availableTitle(currentParent, title, documentId);
    if (existing.hpath.split("/").at(-1) !== nextTitle) await kernelPost("/api/filetree/renameDocByID", { id: documentId, title: nextTitle });
  }
  return { documentId, created: !existing, parentId: actualParent };
}

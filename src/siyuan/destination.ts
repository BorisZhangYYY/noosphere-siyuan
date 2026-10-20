/**
 * 按标题在分类文档下落库文章：同名文档覆盖，不存在则新建。
 * 与手动追加（writer.appendArticle）互补——自动分类落库需要幂等，重复保存不能产生多篇同名文档。
 */
import { kernelPost } from "./api";
import { composeArticle } from "../article/compose";
import type { Article } from "../types";

const SIYUAN_ID = /^\d{14}-[a-z0-9]{7}$/;

/** 思源 hpath 不允许这些字符，替换为可读的全角字符而不是直接删除。 */
const FILENAME_CHARACTERS: Record<string, string> = {
  "/": "／", "\\": "＼", ":": "：", "*": "＊", "?": "？", '"': "＂", "<": "＜", ">": "＞", "|": "｜",
};

export function safeDocumentTitle(title: string): string {
  return title
    .replace(/\s+/g, " ")
    .replace(/[\\/:*?"<>|]/g, character => FILENAME_CHARACTERS[character])
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

interface DocumentLocation { notebook: string; hpath: string }

/**
 * 分类文档既可能是笔记本本身（不常见），也可能是普通文档。
 * 与 Noosphere 本体一致，两种情况都要能定位到 notebook + hpath。
 */
export async function locateDocument(documentId: string): Promise<DocumentLocation> {
  const id = documentId.trim();
  if (!SIYUAN_ID.test(id) && !/^\d{14}$/.test(id)) throw new Error("请输入有效的思源文档 ID");
  const notebooks = await kernelPost<{ notebooks?: Array<{ id: string; name: string }> }>("/api/notebook/lsNotebooks", {});
  const list = notebooks?.notebooks || [];
  if (list.some(notebook => notebook.id === id)) return { notebook: id, hpath: "" };
  const hpath = await kernelPost<string>("/api/filetree/getHPathByID", { id });
  const location = await kernelPost<{ notebook?: string }>("/api/filetree/getPathByID", { id });
  if (!location?.notebook || typeof hpath !== "string" || !hpath) throw new Error("无法定位目标文档所在的笔记本");
  return { notebook: location.notebook, hpath };
}

/** 同名文章只允许有一篇：先按完整 hpath 查找，找到就更新而不是新建。 */
export async function findDocumentByTitle(parentDocId: string, title: string): Promise<string | null> {
  const safe = safeDocumentTitle(title);
  if (!safe) return null;
  const { notebook, hpath } = await locateDocument(parentDocId);
  const childHpath = hpath ? `${hpath.replace(/\/+$/, "")}/${safe}` : `/${safe}`;
  const ids = await kernelPost<string[]>("/api/filetree/getIDsByHPath", { notebook, path: childHpath });
  return Array.isArray(ids) && ids[0] ? ids[0] : null;
}

export interface EnsureArticleDocumentOptions {
  /** 已存在的同名文档 ID；传入时直接覆盖正文，跳过查找。 */
  existingId?: string;
}

/**
 * 把文章写到分类文档下的一篇同名文档里。
 * 返回文档 ID 与是否新建，调用方用它更新 savedDocumentId 与“打开文档”按钮。
 */
export async function ensureArticleDocument(
  parentDocId: string,
  article: Article,
  markdown: string,
  options: EnsureArticleDocumentOptions = {},
): Promise<{ documentId: string; created: boolean }> {
  const title = safeDocumentTitle(article.title);
  if (!title) throw new Error("文章标题为空，无法创建文档");
  const content = composeArticle(article, markdown).trim();
  const existing = options.existingId || await findDocumentByTitle(parentDocId, title);
  if (existing) {
    await kernelPost("/api/block/updateBlock", { id: existing, dataType: "markdown", data: content });
    return { documentId: existing, created: false };
  }
  const { notebook, hpath } = await locateDocument(parentDocId);
  const childHpath = hpath ? `${hpath.replace(/\/+$/, "")}/${title}` : `/${title}`;
  const documentId = await kernelPost<string>("/api/filetree/createDocWithMd", {
    notebook,
    path: childHpath,
    markdown: content,
  });
  if (!documentId) throw new Error("思源未返回新建文档 ID");
  return { documentId, created: true };
}

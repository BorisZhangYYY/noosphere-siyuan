/** Validate the destination document and append one article import to it. */
import { kernelPost } from "./api";
import { composeArticle } from "../article/compose";
import type { Article } from "../types";
import { composeBlockDOM } from "../article/editor";
import type { Lute } from "siyuan";

const SIYUAN_ID = /^\d{14}-[a-z0-9]{7}$/;
interface ChildBlock { id: string; type: string; content?: string; markdown?: string }

/** 目标属性同时用于文档校验与判断是否有真正的文档标题。 */
async function targetAttributes(documentId: string): Promise<{ id: string; attrs: Record<string, string> }> {
  const id = documentId.trim();
  if (!SIYUAN_ID.test(id)) throw new Error("请输入有效的思源文档 ID");
  const attrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id });
  if (attrs?.type !== "doc") throw new Error("目标 ID 不是文档，请填写文章文档 ID");
  return { id, attrs };
}

/** Check that the supplied ID is a document before making any block changes. */
export async function validateTargetDocument(documentId: string): Promise<string> {
  return (await targetAttributes(documentId)).id;
}

/** 只把初始空段落视作占位；图片、代码、列表等无文字内容也属于已有正文。 */
function emptyDocument(children: ChildBlock[]): boolean {
  return children.length === 0 || (children.length === 1 && children[0].type === "p"
    && !(children[0].content || "").replace(/[\s\u200b]/g, "") && !(children[0].markdown || "").replace(/[\s\u200b]/g, ""));
}

/** Append the composed article only after destination validation. */
export async function appendArticle(documentId: string, article: Article, markdown: string, blockDOM?: string): Promise<string> {
  const { id, attrs } = await targetAttributes(documentId);
  let title = article.title.replace(/\s+/g, " ").trim();
  if (blockDOM) {
    const body = document.createElement("div"); body.innerHTML = blockDOM;
    const heading = body.firstElementChild;
    if (heading?.getAttribute("data-type") === "NodeHeading") {
      title = (heading.querySelector('[contenteditable][spellcheck]')?.textContent || title).replace(/[\s\u200b]+/g, " ").trim();
    }
  }
  // 使用可读的全角字符保留标题含义，也让写入失败后的同名空文档能被正确识别。
  const filenameCharacters: Record<string, string> = { "/": "／", "\\": "＼", ":": "：", "*": "＊", "?": "？", '"': "＂", "<": "＜", ">": "＞", "|": "｜" };
  title = title.replace(/[\\/:*?"<>|]/g, character => filenameCharacters[character]).replace(/[\x00-\x1f\x7f]/g, "");
  let children: ChildBlock[] | undefined;
  if (attrs["custom-sy-title-empty"] === "true" || (title && attrs.title === title)) {
    children = await kernelPost<ChildBlock[]>("/api/block/getChildBlocks", { id });
    if (!Array.isArray(children)) throw new Error("未能读取目标文档内容，请重试");
  }
  const useDocumentTitle = !!title && !!children && emptyDocument(children);
  let content = composeArticle(article, markdown);
  if (useDocumentTitle) content = content.replace(/^#{1,6}\s+[^\n]+\n+/, "");
  if (blockDOM) {
    const factory = (window as unknown as { Lute?: { New(): Lute; NewNodeID(): string } }).Lute;
    const lute = factory?.New();
    if (!lute) throw new Error("思源编辑组件未加载，文章仍保留在知流中，请重启后再保存");
    content = composeBlockDOM(article, blockDOM, lute);
    // 每次正式导入使用新的块 ID，不与之前导入的副本共享标识。
    const container = document.createElement("div"); container.innerHTML = content;
    const ids = new Map<string, string>();
    const heading = container.firstElementChild;
    if (useDocumentTitle && heading?.getAttribute("data-type") === "NodeHeading") {
      const headingId = heading.getAttribute("data-node-id");
      if (headingId) ids.set(headingId, id);
      heading.remove();
    }
    container.querySelectorAll<HTMLElement>("[data-node-id]").forEach(node => {
      const previous = node.dataset.nodeId!;
      const next = factory!.NewNodeID(); ids.set(previous, next); node.dataset.nodeId = next;
      node.removeAttribute("data-noosphere-metadata"); node.removeAttribute("data-readonly");
    });
    container.querySelectorAll<HTMLElement>('[data-type~="block-ref"][data-id]').forEach(node => {
      const id = ids.get(node.dataset.id!); if (id) node.dataset.id = id;
    });
    content = container.innerHTML;
  }
  // 先命名再写正文：命名失败不会追加半篇文章；写入失败后仍可向同名空文档重试。
  if (useDocumentTitle && attrs["custom-sy-title-empty"] === "true") {
    await kernelPost("/api/filetree/renameDocByID", { id, title });
  }
  if (useDocumentTitle) {
    const current = await kernelPost<ChildBlock[]>("/api/block/getChildBlocks", { id });
    if (!Array.isArray(current) || !emptyDocument(current) || current[0]?.id !== children?.[0]?.id) {
      throw new Error("目标文档内容已变化，请检查后重新保存");
    }
  }
  // 更新单个段落只接受一个块；已确认空白的文档必须整篇写入，保留全部正文与元数据。
  const data = await kernelPost<Array<{ doOperations?: Array<{ id?: string; action?: string }> }>>(
    useDocumentTitle ? "/api/block/updateBlock" : "/api/block/appendBlock",
    { ...(useDocumentTitle ? { id } : { parentID: id }), dataType: blockDOM ? "dom" : "markdown", data: content },
  );
  const insertedId = data?.flatMap(transaction => transaction.doOperations || [])
    .find(operation => operation.id && operation.action !== "delete")?.id;
  if (!insertedId) throw new Error("思源未确认写入结果，请检查目标文档后再重试");
  return insertedId;
}

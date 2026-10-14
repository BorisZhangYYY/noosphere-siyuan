/** Validate the destination document and append one article import to it. */
import { kernelPost } from "./api";
import { composeArticle } from "../article/compose";
import type { Article } from "../types";
import { composeBlockDOM } from "../article/editor";
import type { Lute } from "siyuan";

const SIYUAN_ID = /^\d{14}-[a-z0-9]{7}$/;

/** Check that the supplied ID is a document before making any block changes. */
export async function validateTargetDocument(documentId: string): Promise<string> {
  const id = documentId.trim();
  if (!SIYUAN_ID.test(id)) throw new Error("请输入有效的思源文档 ID");
  const attrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id });
  if (attrs?.type !== "doc") throw new Error("目标 ID 不是文档，请填写文章文档 ID");
  return id;
}

/** Append the composed article only after destination validation. */
export async function appendArticle(documentId: string, article: Article, markdown: string, blockDOM?: string): Promise<string> {
  const id = await validateTargetDocument(documentId);
  let content = composeArticle(article, markdown);
  if (blockDOM) {
    const factory = (window as unknown as { Lute?: { New(): Lute; NewNodeID(): string } }).Lute;
    const lute = factory?.New();
    if (!lute) throw new Error("思源编辑组件未加载，文章仍保留在知流中，请重启后再保存");
    content = composeBlockDOM(article, blockDOM, lute);
    // 每次正式导入使用新的块 ID，不与之前导入的副本共享标识。
    const container = document.createElement("div"); container.innerHTML = content;
    const ids = new Map<string, string>();
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
  const data = await kernelPost<Array<{ doOperations?: Array<{ id?: string }> }>>(
    "/api/block/appendBlock",
    { parentID: id, dataType: blockDOM ? "dom" : "markdown", data: content },
  );
  const insertedId = data?.[0]?.doOperations?.[0]?.id;
  if (!insertedId) throw new Error("思源未确认写入结果，请检查目标文档后再重试");
  return insertedId;
}

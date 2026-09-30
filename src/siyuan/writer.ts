/** Validate the destination document and append one article import to it. */
import { kernelPost } from "./api";
import { composeArticle } from "../article/compose";
import type { Article } from "../types";

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
export async function appendArticle(documentId: string, article: Article, markdown: string): Promise<string> {
  const id = await validateTargetDocument(documentId);
  const data = await kernelPost<Array<{ doOperations?: Array<{ id?: string }> }>>(
    "/api/block/appendBlock",
    { parentID: id, dataType: "markdown", data: composeArticle(article, markdown) },
  );
  const insertedId = data?.[0]?.doOperations?.[0]?.id;
  if (!insertedId) throw new Error("思源未确认写入结果，请检查目标文档后再重试");
  return insertedId;
}

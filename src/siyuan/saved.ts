/** 核对已保存文档的可用性；接口失败或缺少结果时保留原状态。 */
import { kernelPost } from "./api";

/** 去重并分批查询，只接受明确的布尔结果，避免把网络异常当成删除。 */
export async function checkSavedDocuments(documentIds: readonly string[]): Promise<Map<string, boolean>> {
  const ids = [...new Set(documentIds.filter(id => /^\d{14}-[a-z0-9]{7}$/.test(id)))];
  const availability = new Map<string, boolean>();
  for (let offset = 0; offset < ids.length; offset += 128) {
    const batch = ids.slice(offset, offset + 128);
    const result = await kernelPost<Record<string, boolean> | null>("/api/block/checkBlocksExist", { ids: batch }, 8000);
    for (const id of batch) if (typeof result?.[id] === "boolean") availability.set(id, result[id]);
  }
  return availability;
}

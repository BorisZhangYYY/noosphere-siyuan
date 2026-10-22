/** 统一解析笔记本/文档锚点，并用真实文档路径约束读写范围。 */
import { kernelPost } from "./api";

export const SIYUAN_ID = /^\d{14}-[a-z0-9]{7}$/;
export interface DocumentLocation { id: string; notebook: string; path: string; hpath: string; isNotebook: boolean }

/** SQL 接口没有绑定参数，所有字符串都按字面量转义。 */
export function sqlLiteral(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

/** 笔记本的分类范围始终为 /；即使有同 ID 的顶层文档，也不改变子文档的真实路径。 */
export async function locateDocument(documentId: string, signal?: AbortSignal): Promise<DocumentLocation> {
  const id = documentId.trim();
  if (!SIYUAN_ID.test(id) && !/^\d{14}$/.test(id)) throw new Error("请输入有效的思源笔记本或文档 ID");
  const notebooks = await kernelPost<{ notebooks: Array<{ id: string }> }>("/api/notebook/lsNotebooks", {}, undefined, signal);
  if (notebooks.notebooks.some(item => item.id === id)) return { id, notebook: id, path: "/", hpath: "", isNotebook: true };
  const attrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id }, undefined, signal);
  if (attrs.type !== "doc") throw new Error("分类锚点必须是笔记本或文档，不能是正文块");
  const location = await kernelPost<{ notebook: string; path: string }>("/api/filetree/getPathByID", { id }, undefined, signal);
  const hpath = await kernelPost<string>("/api/filetree/getHPathByID", { id }, undefined, signal);
  if (!location.notebook || !location.path?.endsWith(`/${id}.sy`) || typeof hpath !== "string" || !hpath) throw new Error("无法定位目标文档");
  return { id, ...location, hpath, isNotebook: false };
}

/** 打开入口只检查根文档能力，不依赖分类读取，也不写入或规范文档内容。 */
export async function classificationRootDocumentId(root: DocumentLocation): Promise<string | null> {
  if (!root.isNotebook) return root.id;
  // 关闭功能后旧 .sy 文件可能仍存在，不能将隐藏文档当成可用入口。
  const config = await kernelPost<{ conf?: { fileTree?: { boxDocEnabled?: boolean } } }>("/api/system/getConf", {});
  if (!config.conf?.fileTree?.boxDocEnabled) return null;
  const attrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id: root.id });
  if (attrs.type !== "doc") throw new Error("笔记本根文档尚未就绪，请在思源中打开笔记本后重试");
  return root.id;
}

/** 文档 ID 路径用于归属判断，避免同名目录、相似前缀和其他笔记本混入。 */
export function withinRoot(location: Pick<DocumentLocation, "notebook" | "path">, root: DocumentLocation, includeRoot = false): boolean {
  return location.notebook === root.notebook && (root.isNotebook
    || location.path.startsWith(`${root.path.slice(0, -3)}/`)
    || (includeRoot && location.path === root.path));
}

/** SQL 与内存校验采用同一范围；表别名只能由代码传入。 */
export function rootCondition(root: DocumentLocation, alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}box = ${sqlLiteral(root.notebook)}`
    + (root.isNotebook ? "" : ` AND ${prefix}path LIKE ${sqlLiteral(`${root.path.slice(0, -3)}/%`)}`);
}

export function parentDocumentId(location: Pick<DocumentLocation, "path" | "notebook">): string {
  const parts = location.path.replace(/\.sy$/, "").split("/").filter(Boolean);
  return parts.at(-2) || location.notebook;
}

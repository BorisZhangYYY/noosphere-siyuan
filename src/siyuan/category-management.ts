/** 分类管理仅修改选定根下的分类文档；描述、用户正文与目录分开维护。 */
import { kernelPost } from "./api";
import { locateDocument, SIYUAN_ID, sqlLiteral, withinRoot, type DocumentLocation } from "./location";
import { CATEGORY_ATTR, discoverCategories, INDEX_ATTR, OVERVIEW_ROOT_ATTR, refreshCategoryIndex, type CategoryNode } from "./tree";
import { DESCRIPTION_ATTR, DESCRIPTION_HEADING_ATTR, descriptionSection, readCategoryDescription } from "./category-description";
import { safeDocumentTitle } from "./destination";

interface ChildBlock { id: string; type: string; subType?: string; content?: string; markdown?: string }
interface Operations { doOperations?: Array<{ id?: string; action?: string }> }
export interface CategoryInput { name: string; description: string; parentId: string }
const HELP_ATTR = "custom-zl-classification-help";
const ROOT_HELP = "本页承担分类目录树，默认锁定；不推荐修改“目录”“说明”和各分类页的二级标题，以保持文档结构清晰。目录随分类新建、删除、改名和移动自动更新，点击目录项可打开文档。\n\n请从知流的“分类配置 → 分类管理”新增或编辑分类；分类描述应说明收录主题、典型内容和分类边界，可手动填写，也可先用 AI 生成再确认同步。你也可以在思源原生菜单中解锁分类文档，直接编辑分类描述所在位置，后续分类会读取最新描述；主动解锁后不会被再次强制锁定。文章文档始终可编辑。\n\n自动分类使用分类文档 ID、完整路径和描述区域的块标记，不依赖二级标题的文字。只改标题名称不会使分类失效；删除或重建描述标题可能丢失区域标记，可在分类管理中重新保存描述来修复。未找到明确匹配分类时，文章保存在分类根下。";
const serial = new Map<string, Promise<unknown>>();

/** 防止当前前端的重复点击创建多个目录或同时覆盖同一描述。 */
async function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = serial.get(key);
  const pending = (async () => { if (previous) await previous.catch(() => undefined); return operation(); })();
  serial.set(key, pending);
  try { return await pending; } finally { if (serial.get(key) === pending) serial.delete(key); }
}
function insertedId(result: Operations[]): string {
  const id = result.flatMap(item => item.doOperations || []).find(item => item.id && item.action !== "delete")?.id;
  if (!id || !SIYUAN_ID.test(id)) throw new Error("思源未确认内容创建结果");
  return id;
}
function descriptionMarkdown(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[\\`*_{}\[\]<>#]/g, "\\$&");
}
function validated(input: CategoryInput): CategoryInput {
  const name = safeDocumentTitle(input.name), description = input.description.trim();
  if (!name || name.length > 80) throw new Error("请填写不超过 80 字的分类名称");
  if (!description || description.length > 2000) throw new Error("请填写 1–2000 字的分类描述");
  return { ...input, name, description };
}
async function kramdown(id: string): Promise<string> {
  return (await kernelPost<{ kramdown: string }>("/api/block/getBlockKramdown", { id })).kramdown;
}
async function markDescriptionHeading(id: string, documentId: string): Promise<void> {
  await kernelPost("/api/attr/setBlockAttrs", { id, attrs: { [DESCRIPTION_ATTR]: "true" } });
  await kernelPost("/api/attr/setBlockAttrs", { id: documentId, attrs: { [DESCRIPTION_HEADING_ATTR]: id } });
}

/** 为旧介绍补标题；显式保存时只替换该区域，保留目录及其他同级章节。 */
export async function writeCategoryDescription(id: string, next?: string): Promise<void> {
  const markdown = await kramdown(id), section = descriptionSection(markdown);
  const children = await kernelPost<ChildBlock[]>("/api/block/getChildBlocks", { id });
  const heading = children.find(child => child.id === section?.headingId)
    || children.find(child => child.type === "h" && child.content === "分类描述");
  if (heading && section) {
    await markDescriptionHeading(heading.id, id);
    if (next === undefined) return;
    const start = children.indexOf(heading) + 1;
    let end = children.findIndex((child, index) => index >= start && child.type === "h" && Number(child.subType?.slice(1) || 1) <= section.level);
    if (end < 0) end = children.length;
    const body: ChildBlock[] = [];
    for (const child of children.slice(start, end)) {
      const attrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id: child.id });
      if (attrs[INDEX_ATTR]) break;
      body.push(child);
    }
    if (body.length) {
      await kernelPost("/api/block/updateBlock", { id: body[0].id, dataType: "markdown", data: descriptionMarkdown(next) });
      for (const extra of body.slice(1)) await kernelPost("/api/block/deleteBlock", { id: extra.id });
    } else await kernelPost("/api/block/insertBlock", { previousID: heading.id, dataType: "markdown", data: descriptionMarkdown(next) });
  } else {
    const attrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id });
    const description = next ?? readCategoryDescription(markdown, attrs["custom-zl-desc"]);
    const intro = children.find(child => child.type === "p" && child.content?.trim());
    if (intro) {
      const created = await kernelPost<Operations[]>("/api/block/insertBlock", { nextID: intro.id, dataType: "markdown", data: "## 分类描述" });
      await markDescriptionHeading(insertedId(created), id);
      if (next !== undefined || attrs["custom-zl-desc"]) await kernelPost("/api/block/updateBlock", { id: intro.id, dataType: "markdown", data: descriptionMarkdown(description) });
    } else {
      const created = await kernelPost<Operations[]>("/api/block/prependBlock", { parentID: id, dataType: "markdown",
        data: `## 分类描述${description ? "\n\n" + descriptionMarkdown(description) : ""}` });
      await markDescriptionHeading(insertedId(created), id);
    }
  }
  // 描述区成为唯一来源；移除旧属性副本，后续直接修改思源正文会立即生效。
  await kernelPost("/api/attr/setBlockAttrs", { id, attrs: { "custom-zl-desc": "" } });
}

/** 普通根文档与启用的顶层笔记本文档共用目录结构，不额外创建总览文档。 */
export async function ensureClassificationRoot(rootId: string): Promise<string | null> {
  return exclusive(`root:${rootId}`, async () => {
    const root = await locateDocument(rootId);
    if (root.isNotebook) {
      // 笔记本仍以 / 作为分类范围；是否能承载正文另由内核能力与开关决定。
      // 关闭功能后旧 .sy 文件可能仍存在，因此不能只凭块存在就写入隐藏文档。
      const config = await kernelPost<{ conf?: { fileTree?: { boxDocEnabled?: boolean } } }>("/api/system/getConf", {});
      if (!config.conf?.fileTree?.boxDocEnabled) return null;
    }
    const id = root.id;
    const attrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id });
    if (root.isNotebook && attrs.type !== "doc") throw new Error("笔记本根文档尚未就绪，请在思源中打开笔记本后重试");
    let children = await kernelPost<ChildBlock[]>("/api/block/getChildBlocks", { id });
    const section = async (key: string, title: string, legacy: string): Promise<string> => {
      const bound = children.find(child => child.id === attrs[key] && child.type === "h");
      if (bound) return bound.id;
      // 仅迁移插件旧结构，之后始终根据块 ID 定位，不再依赖标题文字。
      const old = attrs[OVERVIEW_ROOT_ATTR] === id ? children.find(child => child.type === "h" && child.content === legacy) : undefined;
      const headingId = old?.id || insertedId(await kernelPost<Operations[]>("/api/block/appendBlock", { parentID: id, dataType: "markdown", data: `## ${title}` }));
      if (old) await kernelPost("/api/block/updateBlock", { id: headingId, dataType: "markdown", data: `## ${title}` });
      await kernelPost("/api/attr/setBlockAttrs", { id, attrs: { [key]: headingId } });
      return headingId;
    };
    const directory = await section("custom-zl-root-directory-heading", "目录", "全部分类");
    const helpHeading = await section("custom-zl-root-help-heading", "说明", "分类使用说明");
    let help = children.find(child => child.id === attrs["custom-zl-root-help-block"]);
    if (!help) {
      for (const child of children.filter(child => child.type === "p")) {
        const childAttrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id: child.id });
        if (childAttrs[HELP_ATTR] === id) { help = child; break; }
      }
    }
    const helpData = `${ROOT_HELP}\n{: ${HELP_ATTR}="${id}"}`;
    if (!help) {
      // 一个受管段落承载说明，避免多段说明在后续同步时重复追加。
      const result = await kernelPost<Operations[]>("/api/block/insertBlock", { previousID: helpHeading, dataType: "markdown", data: helpData.replace(/\n\n/g, "\n") });
      help = { id: insertedId(result), type: "p" };
    } else {
      const previous = await kramdown(help.id);
      if (!previous.includes(ROOT_HELP.replace(/\n\n/g, "\n"))) await kernelPost("/api/block/updateBlock", { id: help.id, dataType: "markdown", data: helpData.replace(/\n\n/g, "\n") });
    }
    await kernelPost("/api/attr/setBlockAttrs", { id, attrs: { [OVERVIEW_ROOT_ATTR]: id, "custom-zl-root-help-block": help.id } });
    const indexId = await refreshCategoryIndex(id, { create: true });
    children = await kernelPost<ChildBlock[]>("/api/block/getChildBlocks", { id });
    // 按块 ID 排列目录 → 说明；保留根文档中用户已有的其他内容。
    for (const [blockId, previousID] of [[indexId, directory], [helpHeading, indexId], [help.id, helpHeading]]) {
      if (!blockId || !previousID) continue;
      if (children.findIndex(child => child.id === blockId) !== children.findIndex(child => child.id === previousID) + 1) {
        await kernelPost("/api/block/moveBlock", { id: blockId, previousID, parentID: id });
        const block = children.find(child => child.id === blockId);
        children = children.filter(child => child.id !== blockId);
        if (block) children.splice(children.findIndex(child => child.id === previousID) + 1, 0, block);
      }
    }
    return id;
  });
}

/** 只在用户打开分类管理时规范旧介绍，不在分类读取期间改写文档。 */
export async function loadManagedCategories(rootId: string): Promise<{ rootDocumentId: string | null; categories: CategoryNode[]; rootLabel: string }> {
  const rootDocumentId = await ensureClassificationRoot(rootId);
  const categories = await discoverCategories(rootId);
  for (const category of categories) await exclusive(`description:${category.id}`, () => writeCategoryDescription(category.id));
  const root = await locateDocument(rootId);
  const notebooks = root.isNotebook ? await kernelPost<{ notebooks: Array<{ id: string; name: string }> }>("/api/notebook/lsNotebooks", {}) : undefined;
  return { rootDocumentId, categories: await discoverCategories(rootId), rootLabel: root.hpath || notebooks?.notebooks.find(item => item.id === root.id)?.name || root.id };
}

async function categoryLocation(root: DocumentLocation, id: string): Promise<DocumentLocation> {
  const location = await locateDocument(id);
  if (!withinRoot(location, root)) throw new Error("分类已移出当前根目录，请刷新后重试");
  return location;
}

/** 新建后立即保留绑定，后续同步失败时由管理页在同一文档重试。 */
export async function createCategory(rootId: string, input: CategoryInput, onCreated?: (id: string) => void): Promise<string> {
  const value = validated(input);
  return exclusive(`create:${rootId}:${value.parentId}:${value.name}`, async () => {
    const root = await locateDocument(rootId), parent = value.parentId === root.id ? root : await categoryLocation(root, value.parentId);
    if (parent.id !== root.id) {
      const attrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id: parent.id });
      if (!attrs[CATEGORY_ATTR]) throw new Error("父分类已取消分类标记，请刷新后重试");
    }
    const path = `${parent.hpath}/${value.name}`;
    if ((await kernelPost<string[]>("/api/filetree/getIDsByHPath", { notebook: parent.notebook, path })).length) throw new Error("该位置已有同名文档，请换一个分类名称");
    const id = await kernelPost<string>("/api/filetree/createDocWithMd", { notebook: parent.notebook, path,
      markdown: `## 分类描述\n\n${descriptionMarkdown(value.description)}\n\n## 文章目录\n\n暂无子文档。\n{: ${INDEX_ATTR}="true"}` });
    onCreated?.(id);
    await kernelPost("/api/attr/setBlockAttrs", { id, attrs: { [CATEGORY_ATTR]: "true" } });
    await writeCategoryDescription(id);
    await refreshCategoryIndex(id, { create: true });
    await ensureClassificationRoot(root.id);
    return id;
  });
}

/** 编辑只更新名称和描述；不替换整个文档，也不移动文章或分类。 */
export async function updateCategory(rootId: string, id: string, input: CategoryInput, allowUnmarked = false): Promise<void> {
  const value = validated(input);
  await exclusive(`description:${id}`, async () => {
    const root = await locateDocument(rootId), location = await categoryLocation(root, id);
    const attrs = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id });
    if (!attrs[CATEGORY_ATTR] && !allowUnmarked) throw new Error("该文档已取消分类标记，请刷新后重试");
    const parentPath = location.hpath.slice(0, location.hpath.lastIndexOf("/"));
    const sameTitle = await kernelPost<string[]>("/api/filetree/getIDsByHPath", { notebook: location.notebook, path: `${parentPath}/${value.name}` });
    if (sameTitle.some(other => other !== id)) throw new Error("该位置已有同名文档，请使用其他名称");
    await writeCategoryDescription(id, value.description);
    if (location.hpath.split("/").at(-1) !== value.name) await kernelPost("/api/filetree/renameDocByID", { id, title: value.name });
    await kernelPost("/api/attr/setBlockAttrs", { id, attrs: { [CATEGORY_ATTR]: "true" } });
    await refreshCategoryIndex(id, { create: true });
    await ensureClassificationRoot(root.id);
  });
}

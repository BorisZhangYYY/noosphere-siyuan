/** 分类管理仅修改选定根下的分类文档；描述、用户正文与目录分开维护。 */
import { kernelPost } from "./api";
import { locateDocument, SIYUAN_ID, sqlLiteral, withinRoot, type DocumentLocation } from "./location";
import { attrFromIal, CATEGORY_ATTR, discoverCategories, INDEX_ATTR, OVERVIEW_ROOT_ATTR, refreshCategoryIndex, type CategoryNode } from "./tree";
import { DESCRIPTION_ATTR, DESCRIPTION_HEADING_ATTR, descriptionSection, readCategoryDescription } from "./category-description";
import { safeDocumentTitle } from "./destination";

interface ChildBlock { id: string; type: string; subType?: string; content?: string; markdown?: string }
interface Operations { doOperations?: Array<{ id?: string; action?: string }> }
export interface CategoryInput { name: string; description: string; parentId: string }
const HELP_ATTR = "custom-zl-classification-help";
const OVERVIEW_HELP = "知流根据分类名称、完整路径和“分类描述”选择已有分类；没有匹配时保存在分类根下。分类页和总览页默认锁定，文章保持可编辑。请在知流设置的“分类管理”中修改分类；也可在思源解锁后编辑“分类描述”。目录标题改名不影响分类，目录链接会自动维护。";
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

/** 根文档直接展示分类；笔记本没有正文，在其下创建可复用的分类总览文档。 */
export async function ensureClassificationOverview(rootId: string): Promise<string> {
  return exclusive(`overview:${rootId}`, async () => {
    const root = await locateDocument(rootId);
    let id = root.id;
    if (root.isNotebook) {
      await kernelPost("/api/sqlite/flushTransaction", {});
      const rows = await kernelPost<Array<{ id: string; ial: string }>>("/api/query/sql", {
        stmt: `SELECT id, ial FROM blocks WHERE type = 'd' AND box = ${sqlLiteral(root.notebook)} AND ial LIKE '%${OVERVIEW_ROOT_ATTR}%' ORDER BY created LIMIT 2147483647`,
      });
      const owned = rows.find(row => attrFromIal(row.ial, OVERVIEW_ROOT_ATTR) === root.id);
      if (owned) id = owned.id;
      else {
        let suffix = 1, path = "/分类总览";
        while ((await kernelPost<string[]>("/api/filetree/getIDsByHPath", { notebook: root.notebook, path })).length) path = `/分类总览（${++suffix}）`;
        id = await kernelPost<string>("/api/filetree/createDocWithMd", { notebook: root.notebook, path,
          markdown: `## 分类使用说明\n\n${OVERVIEW_HELP}\n{: ${HELP_ATTR}="${root.id}"}\n\n## 全部分类\n\n暂无分类。\n{: ${INDEX_ATTR}="true"}` });
        if (!(await kramdown(id)).includes(`${HELP_ATTR}="${root.id}"`)) throw new Error("分类总览位置已被其他文档占用，请重试");
      }
    }
    const markdown = await kramdown(id);
    const addedHelp = !markdown.includes(`${HELP_ATTR}="${root.id}"`);
    if (addedHelp) {
      await kernelPost("/api/block/appendBlock", { parentID: id, dataType: "markdown",
        data: `## 分类使用说明\n\n${OVERVIEW_HELP}\n{: ${HELP_ATTR}="${root.id}"}\n\n## 全部分类` });
    }
    await kernelPost("/api/attr/setBlockAttrs", { id, attrs: { [OVERVIEW_ROOT_ATTR]: root.id } });
    const indexId = await refreshCategoryIndex(id, { create: true });
    if (addedHelp && indexId) {
      const children = await kernelPost<ChildBlock[]>("/api/block/getChildBlocks", { id });
      const heading = children.find(child => child.type === "h" && child.content === "全部分类");
      if (heading && children.findIndex(child => child.id === indexId) < children.indexOf(heading)) {
        await kernelPost("/api/block/moveBlock", { id: indexId, previousID: heading.id, parentID: id });
      }
    }
    return id;
  });
}

/** 只在用户打开分类管理时规范旧介绍，不在分类读取期间改写文档。 */
export async function loadManagedCategories(rootId: string): Promise<{ overviewId: string; categories: CategoryNode[]; rootLabel: string }> {
  const overviewId = await ensureClassificationOverview(rootId);
  const categories = await discoverCategories(rootId);
  for (const category of categories) await exclusive(`description:${category.id}`, () => writeCategoryDescription(category.id));
  const root = await locateDocument(rootId);
  const notebooks = root.isNotebook ? await kernelPost<{ notebooks: Array<{ id: string; name: string }> }>("/api/notebook/lsNotebooks", {}) : undefined;
  return { overviewId, categories: await discoverCategories(rootId), rootLabel: root.hpath || notebooks?.notebooks.find(item => item.id === root.id)?.name || root.id };
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
    await ensureClassificationOverview(root.id);
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
    await ensureClassificationOverview(root.id);
  });
}

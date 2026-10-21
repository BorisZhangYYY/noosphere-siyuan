/** 独立分类管理窗口：模型只填表单，用户确认后才把分类与描述同步到思源。 */
import { Dialog, openTab, type App } from "siyuan";
import { createCategory, loadManagedCategories, updateCategory } from "./siyuan/category-management";
import { generateCategoryDescription } from "./review/category-description";
import type { CategoryNode } from "./siyuan/tree";
import type { Settings } from "./types";

export function openCategoryManager(app: App, settings: Settings, onClosed: () => void, onOpenDocument: () => void = () => undefined): () => void {
  let closed = false, busy = false, editingId: string | undefined, partialId: string | undefined;
  let categories: CategoryNode[] = [], overviewId = "";
  const controller = new AbortController();
  const dialog = new Dialog({ title: "分类管理", width: `${Math.min(1040, window.innerWidth - 32)}px`, content: `
    <main class="noosphere noosphere__category-page">
      <div class="noosphere__category-toolbar"><span>分类根目录 <strong data-category="root"></strong></span><div><button data-category="overview" class="b3-button b3-button--outline" type="button">打开分类总览</button><button data-category="refresh" class="b3-button b3-button--outline" type="button">刷新</button><button data-category="close" class="b3-button b3-button--outline" type="button">返回设置</button></div></div>
      <section class="noosphere__category-help"><strong>分类依据与编辑方式</strong><p>AI 依据分类名称、完整路径和「分类描述」选择已有分类，未匹配的文章保存在根目录。描述中写清适合收录的主题和不属于此类的内容，会更容易分对。</p><p>分类页和总览页默认锁定，文章仍可编辑。你可以在这里修改描述并同步到思源；直接在思源修改时先解锁。「文章目录」改成「目录」不会影响分类。</p></section>
      <div class="noosphere__category-layout"><section class="noosphere__panel"><h3>已有分类</h3><div data-category="list" class="noosphere__category-list"></div></section>
      <section class="noosphere__panel"><h3 data-category="formTitle">新增分类</h3><label>分类名称<input data-category="name" class="b3-text-field" maxlength="80" placeholder="例如：人工智能"></label><label data-category="parentField">父分类<select data-category="parent" class="b3-select"></select></label><label>分类描述<textarea data-category="description" class="b3-text-field" rows="7" maxlength="2000" placeholder="说明收录范围、典型文章和与其他分类的边界"></textarea></label><div class="noosphere__category-actions"><button data-category="generate" class="b3-button b3-button--outline" type="button">AI 生成描述</button><button data-category="save" class="b3-button noosphere__primary" type="button">新建并同步</button><button data-category="cancel" class="b3-button b3-button--outline" type="button" hidden>取消编辑</button></div><p class="noosphere__field-help">AI 生成后可先修改描述，点击同步才会写入思源。描述保存在文档的「分类描述」区域，文章目录自动维护。</p></section></div>
      <p data-category="status" class="noosphere__category-status" role="status" aria-live="polite"></p>
    </main>`, destroyCallback: () => { closed = true; controller.abort(); onClosed(); } });
  const host = dialog.element.querySelector<HTMLElement>(".noosphere__category-page")!;
  const element = <T extends HTMLElement = HTMLElement>(name: string): T => host.querySelector<T>(`[data-category="${name}"]`)!;
  const name = element<HTMLInputElement>("name"), description = element<HTMLTextAreaElement>("description"), parent = element<HTMLSelectElement>("parent");
  const openDocument = (id: string): void => { openTab({ app, doc: { id } }); dialog.destroy(); onOpenDocument(); };
  element("root").textContent = settings.rootDocumentId;
  const status = (text: string, error = false): void => {
    if (closed) return;
    element("status").textContent = text; element("status").classList.toggle("is-error", error);
  };
  const lock = (value: boolean): void => {
    busy = value;
    if (closed) return;
    host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>("input, button, textarea, select").forEach(item => { item.disabled = value; });
    element<HTMLButtonElement>("overview").disabled = value || !overviewId;
    parent.disabled = value || !!editingId;
  };
  const reset = (): void => {
    editingId = undefined; partialId = undefined; name.value = ""; description.value = ""; parent.value = settings.rootDocumentId;
    element("parentField").hidden = false; element("cancel").hidden = true;
    element("formTitle").textContent = "新增分类"; element("save").textContent = "新建并同步";
  };
  const render = (): void => {
    const list = element("list"); list.replaceChildren();
    if (!categories.length) { const empty = document.createElement("p"); empty.textContent = "还没有分类。填写右侧表单，创建第一个分类。"; list.append(empty); }
    for (const category of categories) {
      const row = document.createElement("article"); row.className = "noosphere__category-item";
      const title = document.createElement("strong"); title.textContent = category.path;
      const text = document.createElement("p"); text.textContent = category.description || "尚未填写分类描述";
      const buttons = document.createElement("div");
      for (const action of ["编辑", "打开文档"]) {
        const button = document.createElement("button"); button.className = "b3-button b3-button--outline"; button.type = "button"; button.textContent = action;
        button.addEventListener("click", () => {
          if (busy) return;
          if (action === "打开文档") { openDocument(category.id); return; }
          editingId = category.id; partialId = undefined; name.value = category.name; description.value = category.description;
          element("parentField").hidden = true; element("cancel").hidden = false;
          element("formTitle").textContent = "编辑分类"; element("save").textContent = "保存并同步"; lock(false);
        });
        buttons.append(button);
      }
      row.append(title, text, buttons); list.append(row);
    }
    const previous = parent.value || settings.rootDocumentId;
    parent.replaceChildren(new Option("根目录", settings.rootDocumentId), ...categories.map(item => new Option(item.path, item.id)));
    parent.value = Array.from(parent.options).some(option => option.value === previous) ? previous : settings.rootDocumentId;
  };
  const reload = async (): Promise<void> => {
    const result = await loadManagedCategories(settings.rootDocumentId);
    if (closed) return;
    overviewId = result.overviewId; categories = result.categories; element("root").textContent = result.rootLabel; render();
  };
  const run = async (message: string, operation: () => Promise<void>): Promise<void> => {
    if (busy || closed) return;
    lock(true); status(message);
    try { await operation(); }
    catch (error) { status(error instanceof Error ? error.message : String(error), true); }
    finally { lock(false); }
  };
  element("cancel").addEventListener("click", () => { reset(); lock(false); status(""); });
  element("overview").addEventListener("click", () => { if (overviewId) openDocument(overviewId); });
  element("close").addEventListener("click", () => dialog.destroy());
  element("refresh").addEventListener("click", () => { void run("正在刷新分类…", async () => { await reload(); status("分类和总览已同步。"); }); });
  element("generate").addEventListener("click", () => {
    void run("正在生成描述，生成后请确认再同步…", async () => {
      const parentName = categories.find(item => item.id === parent.value)?.path || "根目录";
      const text = await generateCategoryDescription(name.value, parentName, categories, settings, controller.signal);
      if (!closed) description.value = text;
      status("描述已生成，尚未保存到思源。可修改后点击同步。");
    });
  });
  element("save").addEventListener("click", () => {
    void run("正在同步分类到思源…", async () => {
      const value = { name: name.value, description: description.value, parentId: parent.value };
      if (editingId) await updateCategory(settings.rootDocumentId, editingId, value, partialId === editingId);
      else await createCategory(settings.rootDocumentId, value, id => {
        editingId = id; partialId = id;
        if (!closed) { element("formTitle").textContent = "完成分类同步"; element("save").textContent = "重试同步"; element("cancel").hidden = false; element("parentField").hidden = true; }
      });
      await reload();
      if (!closed) reset();
      status("分类名称、描述和目录已同步到思源。");
    });
  });
  void run("正在读取分类并整理描述区域…", async () => { await reload(); status("分类已加载。可新增或编辑分类。"); });
  return () => { if (!closed) dialog.destroy(); };
}

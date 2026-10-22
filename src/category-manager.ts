/** 分类管理先展示列表，新增和编辑使用弹层；AI 只填写待确认的描述。 */
import { Dialog, openTab, type App } from "siyuan";
import { createCategory, loadManagedCategories, updateCategory } from "./siyuan/category-management";
import { generateCategoryDescription } from "./review/category-description";
import type { CategoryNode } from "./siyuan/tree";
import type { Settings } from "./types";

export function openCategoryManager(app: App, settings: Settings, onClosed: () => void, onOpenDocument: () => void = () => undefined): () => void {
  let closed = false, busy = false, generating = false, editingId: string | undefined, partialId: string | undefined;
  let categories: CategoryNode[] = [], rootDocumentId: string | null = null;
  let controller = new AbortController(), returnFocus: HTMLElement | null = null;
  const dialog = new Dialog({ title: "分类管理", width: `${Math.min(920, window.innerWidth - 32)}px`, content: `
    <main class="noosphere noosphere__category-page">
      <div data-category="browser" class="noosphere__category-browser">
        <div class="noosphere__category-toolbar"><span>分类根目录 <strong data-category="root"></strong></span><div><button data-category="openRoot" class="b3-button b3-button--outline" type="button">打开根文档</button><button data-category="refresh" class="b3-button b3-button--outline" type="button">刷新</button><button data-category="new" class="b3-button noosphere__primary" type="button">新增分类</button></div></div>
        <div data-category="list" class="noosphere__category-list"></div>
      </div>
      <div data-category="editor" class="noosphere__category-overlay" hidden><section class="noosphere__category-form noosphere__panel" role="dialog" aria-modal="true" aria-labelledby="noosphere-category-form-title"><h3 data-category="formTitle" id="noosphere-category-form-title">新增分类</h3><label>分类名称<input data-category="name" class="b3-text-field" maxlength="80" placeholder="例如：人工智能"></label><div data-category="parentField" class="noosphere__field"><span class="noosphere__field-label">父分类</span><div class="noosphere__dropdown"><input data-category="parent" type="hidden"><button data-category="parentTrigger" class="noosphere__dropdown-trigger" type="button" aria-label="父分类" aria-haspopup="listbox" aria-expanded="false"><span data-category="parentLabel">根目录</span><svg class="noosphere__chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5"/></svg></button><div data-category="parentMenu" class="noosphere__dropdown-menu" role="listbox" aria-label="父分类" hidden></div></div></div><label>分类描述<textarea data-category="description" class="b3-text-field" rows="6" maxlength="2000" placeholder="说明收录范围、典型文章和与其他分类的边界"></textarea></label><p class="noosphere__field-help">描述同步到文档的「分类描述」区域。AI 生成后可先修改，点击同步才会写入思源。</p><div class="noosphere__category-actions"><button data-category="generate" class="b3-button b3-button--outline" type="button">AI 生成描述</button><button data-category="cancel" class="b3-button b3-button--outline" type="button">取消</button><button data-category="save" class="b3-button noosphere__primary" type="button">新建并同步</button></div><p data-category="editorStatus" class="noosphere__category-status" role="status" aria-live="polite"></p></section></div>
      <p data-category="status" class="noosphere__category-status" role="status" aria-live="polite"></p>
    </main>`, destroyCallback: () => { closed = true; controller.abort(); onClosed(); } });
  const host = dialog.element.querySelector<HTMLElement>(".noosphere__category-page")!;
  const element = <T extends HTMLElement = HTMLElement>(name: string): T => host.querySelector<T>(`[data-category="${name}"]`)!;
  const name = element<HTMLInputElement>("name"), description = element<HTMLTextAreaElement>("description"), parent = element<HTMLInputElement>("parent");
  const openDocument = (id: string): void => { openTab({ app, doc: { id } }); dialog.destroy(); onOpenDocument(); };
  element("root").textContent = settings.rootDocumentId;
  const status = (text: string, error = false): void => {
    if (closed) return;
    const target = element(element("editor").hidden ? "status" : "editorStatus");
    target.textContent = text; target.classList.toggle("is-error", error);
  };
  const lock = (value: boolean): void => {
    busy = value;
    if (closed) return;
    host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("input, button, textarea").forEach(item => { item.disabled = value; });
    element<HTMLButtonElement>("openRoot").disabled = value || !rootDocumentId;
    // 生成描述时允许取消，取消会终止请求并丢弃晚到结果。
    element<HTMLButtonElement>("cancel").disabled = value && !generating;
  };
  const closeMenu = (): void => { element("parentMenu").hidden = true; element("parentTrigger").setAttribute("aria-expanded", "false"); };
  const selectParent = (id: string): void => {
    parent.value = id;
    element("parentLabel").textContent = categories.find(item => item.id === id)?.path || "根目录";
    element("parentMenu").querySelectorAll<HTMLButtonElement>("button").forEach(button => button.setAttribute("aria-selected", String(button.dataset.value === id)));
    closeMenu();
  };
  const closeEditor = (): void => {
    controller.abort(); controller = new AbortController(); closeMenu();
    element("editor").hidden = true; element("browser").inert = false;
    returnFocus?.focus();
  };
  const edit = (category?: CategoryNode): void => {
    if (busy) return;
    returnFocus = document.activeElement as HTMLElement;
    editingId = category?.id; partialId = undefined;
    name.value = category?.name || ""; description.value = category?.description || "";
    selectParent(category?.parentId || settings.rootDocumentId);
    element("parentField").hidden = !!category;
    element("formTitle").textContent = category ? "编辑分类" : "新增分类";
    element("save").textContent = category ? "保存并同步" : "新建并同步";
    element("editorStatus").textContent = "";
    element("editor").hidden = false; element("browser").inert = true; name.focus();
  };
  const render = (): void => {
    const list = element("list"); list.replaceChildren();
    if (!categories.length) { const empty = document.createElement("p"); empty.textContent = "还没有分类。点击「新增分类」创建第一个分类。"; list.append(empty); }
    for (const category of categories) {
      const row = document.createElement("article"); row.className = "noosphere__category-item";
      const title = document.createElement("strong"); title.textContent = category.path;
      const text = document.createElement("p"); text.textContent = category.description || "尚未填写分类描述";
      const buttons = document.createElement("div");
      for (const action of ["编辑", "打开文档"]) {
        const button = document.createElement("button"); button.className = "b3-button b3-button--outline"; button.type = "button"; button.textContent = action;
        button.addEventListener("click", () => { if (!busy) { if (action === "打开文档") openDocument(category.id); else edit(category); } });
        buttons.append(button);
      }
      row.append(title, text, buttons); list.append(row);
    }
    const menu = element("parentMenu"); menu.replaceChildren();
    for (const item of [{ id: settings.rootDocumentId, path: "根目录" }, ...categories]) {
      const option = document.createElement("button"); option.type = "button"; option.setAttribute("role", "option");
      option.dataset.value = item.id; option.textContent = item.path; option.title = item.path;
      option.addEventListener("click", () => { selectParent(item.id); element("parentTrigger").focus(); }); menu.append(option);
    }
    selectParent(parent.value || settings.rootDocumentId);
  };
  const reload = async (): Promise<void> => {
    const result = await loadManagedCategories(settings.rootDocumentId);
    if (closed) return;
    rootDocumentId = result.rootDocumentId; categories = result.categories; element("root").textContent = result.rootLabel; render();
  };
  const run = async (message: string, operation: () => Promise<void>): Promise<void> => {
    if (busy || closed) return;
    lock(true); status(message);
    try { await operation(); }
    catch (error) { if (!(error instanceof Error && error.name === "AbortError")) status(error instanceof Error ? error.message : String(error), true); }
    finally { lock(false); }
  };
  element("new").addEventListener("click", () => edit());
  element("cancel").addEventListener("click", () => { if (busy && !controller.signal.aborted) controller.abort(); closeEditor(); });
  element("openRoot").addEventListener("click", () => { if (rootDocumentId) openDocument(rootDocumentId); });
  element("refresh").addEventListener("click", () => { void run("正在刷新分类…", async () => { await reload(); status("分类和根文档目录已同步。"); }); });
  element("parentTrigger").addEventListener("click", () => {
    const menu = element("parentMenu"); menu.hidden = !menu.hidden;
    element("parentTrigger").setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) (menu.querySelector<HTMLButtonElement>('[aria-selected="true"]') || menu.querySelector<HTMLButtonElement>("button"))?.focus();
  });
  host.addEventListener("click", event => { if (!(event.target as Element).closest(".noosphere__dropdown")) closeMenu(); });
  host.addEventListener("keydown", event => {
    if (element("editor").hidden) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!element("parentMenu").hidden) { closeMenu(); element("parentTrigger").focus(); } else if (!busy) closeEditor(); }
    const options = Array.from(element("parentMenu").querySelectorAll<HTMLButtonElement>("button"));
    if (!element("parentMenu").hidden && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const index = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    }
    if (event.key === "Tab") {
      closeMenu();
      const controls = Array.from(element("editor").querySelectorAll<HTMLElement>("input:not([type=hidden]), textarea, button")).filter(item => !(item as HTMLButtonElement).disabled && !item.closest("[hidden]"));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  element("generate").addEventListener("click", () => {
    if (busy) return;
    generating = true;
    const signal = controller.signal;
    void run("正在生成描述，生成后请确认再同步…", async () => {
      const parentName = categories.find(item => item.id === parent.value)?.path || "根目录";
      const text = await generateCategoryDescription(name.value, parentName, categories, settings, signal);
      if (closed || signal.aborted) return;
      description.value = text; status("描述已生成，尚未保存到思源。可修改后点击同步。");
    }).finally(() => { generating = false; });
  });
  element("save").addEventListener("click", () => {
    void run("正在同步分类到思源…", async () => {
      const value = { name: name.value, description: description.value, parentId: parent.value };
      if (editingId) await updateCategory(settings.rootDocumentId, editingId, value, partialId === editingId);
      else await createCategory(settings.rootDocumentId, value, id => {
        editingId = id; partialId = id;
        if (!closed) { element("formTitle").textContent = "完成分类同步"; element("save").textContent = "重试同步"; element("parentField").hidden = true; }
      });
      await reload();
      if (!closed) closeEditor();
      status("分类名称、描述和目录已同步到思源。");
    });
  });
  void run("正在读取分类…", async () => { await reload(); status("分类已加载。"); });
  return () => { if (!closed) dialog.destroy(); };
}

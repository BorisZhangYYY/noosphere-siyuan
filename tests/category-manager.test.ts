// @vitest-environment jsdom
/** 验证分类管理里的用户操作：生成先预览、确认后同步，以及失败重试不重复新建。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const dialogs = vi.hoisted(() => [] as Array<{ destroy(): void }>);
vi.mock('siyuan', () => ({ Dialog: class {
  element = document.createElement('div');
  constructor(private options: { content: string; destroyCallback(): void }) { this.element.innerHTML = options.content; document.body.append(this.element); dialogs.push(this); }
  destroy(): void { this.options.destroyCallback(); this.element.remove(); }
}, openTab: vi.fn() }));
vi.mock('../src/siyuan/category-management', () => ({ loadManagedCategories: vi.fn(), createCategory: vi.fn(), updateCategory: vi.fn() }));
vi.mock('../src/review/category-description', () => ({ generateCategoryDescription: vi.fn() }));
import { mountCategoryManager, type CategoryManager } from '../src/category-manager';
import { loadManagedCategories, createCategory, updateCategory } from '../src/siyuan/category-management';
import { generateCategoryDescription } from '../src/review/category-description';
import { DEFAULT_SETTINGS } from '../src/types';
import { openTab, type App } from 'siyuan';
const root = '20260101000000-aaaaaaa', category = '20260101000000-bbbbbbb', created = '20260101000000-ccccccc';
const field = <T extends HTMLElement>(name: string): T => document.querySelector<T>(`[data-category="${name}"]`)!;
const click = (name: string): void => field<HTMLButtonElement>(name).click();
let manager: CategoryManager;
async function ready(): Promise<void> { await vi.waitFor(() => expect(field<HTMLButtonElement>('new').disabled).toBe(false)); }
async function launch(onOpenDocument = vi.fn()): Promise<void> {
  const page = document.createElement('main'); page.className = 'noosphere';
  const host = document.createElement('section'); host.dataset.role = 'categoryManager'; page.append(host); document.body.append(page);
  manager = mountCategoryManager(host, {} as App, () => ({ ...DEFAULT_SETTINGS, rootDocumentId: root }), onOpenDocument);
  await manager.refresh(); await ready();
}
beforeEach(() => {
  vi.resetAllMocks(); dialogs.length = 0; document.body.replaceChildren();
  vi.mocked(loadManagedCategories).mockResolvedValue({ rootDocumentId: root, rootLabel: '分类根', categories: [{ id: category, name: 'AI', description: '原有分类规则', path: 'AI', parentId: root }] });
  vi.mocked(createCategory).mockImplementation(async (_root, _value, onCreated) => { onCreated?.(created); return created; });
  vi.mocked(updateCategory).mockResolvedValue();
});
afterEach(() => manager?.dispose());
it('previews generated text and creates a document only after confirmation', async () => {
  vi.mocked(generateCategoryDescription).mockResolvedValue('小说与文学叙事，不包括游戏设计。');
  await launch(); click('new'); field<HTMLInputElement>('name').value = '小说'; click('generate'); await ready();
  expect(field<HTMLTextAreaElement>('description').value).toContain('文学叙事'); expect(createCategory).not.toHaveBeenCalled();
  expect(field('editorStatus').textContent).toContain('尚未保存');
  click('save'); await ready();
  expect(createCategory).toHaveBeenCalledWith(root, { name: '小说', description: '小说与文学叙事，不包括游戏设计。', parentId: root }, expect.any(Function));
  expect(field('status').textContent).toContain('已同步');
});
it('edits the selected category without creating another document', async () => {
  await launch(); document.querySelector<HTMLButtonElement>('.noosphere__category-item button')!.click();
  expect(field<HTMLInputElement>('name').value).toBe('AI');
  expect(field('parentField').hidden).toBe(true);
  field<HTMLTextAreaElement>('description').value = '人工修改后的规则'; click('save'); await ready();
  expect(updateCategory).toHaveBeenCalledWith(root, category, expect.objectContaining({ name: 'AI', description: '人工修改后的规则' }), false);
  expect(createCategory).not.toHaveBeenCalled();
});
it('retries synchronization of a partially created category instead of creating a duplicate', async () => {
  vi.mocked(createCategory).mockImplementationOnce(async (_root, _value, callback) => { callback?.(created); throw new Error('属性写入失败'); });
  await launch(); click('new'); field<HTMLInputElement>('name').value = '小说'; field<HTMLTextAreaElement>('description').value = '小说规则';
  click('save'); await ready(); expect(field('save').textContent).toBe('重试同步');
  click('save'); await ready();
  expect(createCategory).toHaveBeenCalledOnce();
  expect(updateCategory).toHaveBeenCalledWith(root, created, expect.anything(), true);
});
it('cancels model generation when closed without creating a document', async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(generateCategoryDescription).mockImplementation(async (_name, _parent, _categories, _settings, current) => { signal = current; return new Promise(() => undefined); });
  await launch(); click('new'); field<HTMLInputElement>('name').value = 'AI'; click('generate');
  await vi.waitFor(() => expect(signal).toBeDefined()); manager.dispose();
  expect(signal?.aborted).toBe(true); expect(createCategory).not.toHaveBeenCalled();
});
it('opens the root document from the inline list without creating a management dialog', async () => {
  const closeParent = vi.fn();
  await launch(closeParent);
  expect(dialogs).toHaveLength(0);
  expect(field<HTMLButtonElement>('openRoot').hidden).toBe(false);
  click('openRoot');
  expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ doc: { id: root } }));
  expect(closeParent).toHaveBeenCalledOnce(); expect(document.querySelector('[data-role="categoryManager"]')).not.toBeNull();
});

it('opens the form only on request and supports keyboard selection of a parent category', async () => {
  await launch(); expect(field('editor').hidden).toBe(true);
  click('new'); expect(field('editor').hidden).toBe(false);
  click('parentTrigger'); expect(field('parentMenu').hidden).toBe(false);
  const options = field('parentMenu').querySelectorAll<HTMLButtonElement>('[role="option"]');
  options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(options[1]); options[1].click();
  expect(field<HTMLInputElement>('parent').value).toBe(category);
  expect(field('parentLabel').textContent).toBe('AI'); expect(field('parentMenu').hidden).toBe(true);
  expect(options[1].getAttribute('aria-selected')).toBe('true');
  click('cancel'); expect(field('editor').hidden).toBe(true); expect(createCategory).not.toHaveBeenCalled();
});
it('does not offer a root document when notebook documents are unavailable', async () => {
  vi.mocked(loadManagedCategories).mockResolvedValue({ rootDocumentId: null, rootLabel: '笔记本', categories: [] });
  await launch(); expect(field<HTMLButtonElement>('openRoot').hidden).toBe(true);
  expect(field<HTMLButtonElement>('openRoot').disabled).toBe(true);
});
it('opens an available notebook document using the notebook ID', async () => {
  const notebook = '20260101000000-0000000';
  vi.mocked(loadManagedCategories).mockResolvedValue({ rootDocumentId: notebook, rootLabel: '笔记本', categories: [] });
  await launch();
  expect(field<HTMLButtonElement>('openRoot').hidden).toBe(false);
  expect(field<HTMLButtonElement>('openRoot').disabled).toBe(false);
  click('openRoot');
  expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ doc: { id: notebook } }));
});

it('refreshes the inline list when the saved root changes and clears it when unset', async () => {
  let settings = { ...DEFAULT_SETTINGS, rootDocumentId: root };
  const host = document.createElement('section'); document.body.append(host);
  manager = mountCategoryManager(host, {} as App, () => settings);
  await manager.refresh(); expect(field('list').textContent).toContain('AI');
  settings = { ...settings, rootDocumentId: created };
  vi.mocked(loadManagedCategories).mockResolvedValue({ rootDocumentId: created, rootLabel: '新根', categories: [] });
  await manager.refresh(); expect(loadManagedCategories).toHaveBeenLastCalledWith(created);
  expect(field('list').textContent).not.toContain('AI');
  settings = { ...settings, rootDocumentId: '' };
  await manager.refresh(); expect(field<HTMLButtonElement>('new').disabled).toBe(true);
  expect(field('list').textContent).toContain('请先保存');
});
it('queues a reload when the configured root changes during an in-flight read', async () => {
  let settings = { ...DEFAULT_SETTINGS, rootDocumentId: root };
  let finish!: (value: Awaited<ReturnType<typeof loadManagedCategories>>) => void;
  vi.mocked(loadManagedCategories).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const host = document.createElement('section'); document.body.append(host);
  manager = mountCategoryManager(host, {} as App, () => settings);
  const first = manager.refresh();
  settings = { ...settings, rootDocumentId: created };
  vi.mocked(loadManagedCategories).mockResolvedValue({ rootDocumentId: created, rootLabel: '新根', categories: [] });
  await manager.refresh();
  finish({ rootDocumentId: root, rootLabel: '旧根', categories: [{ id: category, name: '旧分类', path: '旧分类', description: '旧规则', parentId: root }] });
  await first;
  await vi.waitFor(() => expect(loadManagedCategories).toHaveBeenLastCalledWith(created));
  await ready(); expect(field('list').textContent).not.toContain('旧分类');
});

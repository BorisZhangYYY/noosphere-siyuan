/** 文档在别处增删移动时也要刷新，目录自身写入不能触发无限循环。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CategoryIndexMaintenance } from "../src/siyuan/index-maintenance";
import { kernelPost } from "../src/siyuan/api";
import { refreshCategoryIndex } from "../src/siyuan/tree";
vi.mock("../src/siyuan/api", () => ({ kernelPost: vi.fn() }));
vi.mock("../src/siyuan/tree", () => ({ INDEX_ATTR: 'custom-zl-index', INDEX_ENABLED_ATTR: 'custom-zl-index-enabled', discoverCategories: vi.fn(), refreshCategoryIndex: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); vi.mocked(kernelPost).mockResolvedValue([{ id: 'parent' }, { id: 'ancestor' }]); });
afterEach(() => vi.useRealTimers());
it('coalesces create, delete, rename and move events and updates ancestors', async () => {
  const sync = new CategoryIndexMaintenance(() => ({ rootDocumentId: '', autoCreateIndex: false }), vi.fn());
  for (const cmd of ['create', 'removeDoc', 'rename', 'moveDocs']) sync.onMessage({ detail: { cmd } });
  await vi.advanceTimersByTimeAsync(300);
  expect(refreshCategoryIndex).toHaveBeenCalledTimes(2);
  expect(refreshCategoryIndex).toHaveBeenCalledWith('ancestor', { create: false }); sync.stop();
});
it('ignores index block transactions to avoid refreshing itself forever', async () => {
  const sync = new CategoryIndexMaintenance(() => ({ rootDocumentId: '', autoCreateIndex: false }), vi.fn());
  sync.onMessage({ detail: { cmd: 'transactions' } }); await vi.advanceTimersByTimeAsync(1000);
  expect(refreshCategoryIndex).not.toHaveBeenCalled(); sync.stop();
});
it('removes pending work when the plugin unloads', async () => {
  const sync = new CategoryIndexMaintenance(() => ({ rootDocumentId: '', autoCreateIndex: false }), vi.fn());
  sync.schedule(); sync.stop(); await vi.advanceTimersByTimeAsync(1000); expect(kernelPost).not.toHaveBeenCalled();
});

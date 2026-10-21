/** 模型执行与图片下载期间，用户删除或修改分类规则时必须重新决策。 */
import { beforeEach, expect, it, vi } from "vitest";
import { prepareClassification, validateClassification } from "../src/review/classification-plan";
import { locateDocument } from "../src/siyuan/location";
import { discoverCategories } from "../src/siyuan/tree";
import { classifyArticle } from "../src/review/classify";
import { DEFAULT_SETTINGS } from "../src/types";
vi.mock("../src/siyuan/location", () => ({ locateDocument: vi.fn() }));
vi.mock("../src/siyuan/tree", () => ({ discoverCategories: vi.fn() }));
vi.mock("../src/review/classify", () => ({ classifyArticle: vi.fn() }));
const root = { id: 'root', notebook: 'box', path: '/root.sy', hpath: '/AI', isNotebook: false };
const category = { id: 'category', name: '模型', path: '模型', description: '旧规则', parentId: 'root' };
const article = { title: '文章', url: 'https://example.com', markdown: '正文' };
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(locateDocument).mockResolvedValue(root);
  vi.mocked(discoverCategories).mockResolvedValue([category]);
  vi.mocked(classifyArticle).mockResolvedValue({ categoryId: 'category', confidence: 0.9, reason: '匹配' });
});
it('reclassifies if a description changes while the model runs', async () => {
  vi.mocked(discoverCategories).mockResolvedValue([{ ...category, description: '新规则' }]).mockResolvedValueOnce([category]);
  const plan = await prepareClassification('root', article, '正文', DEFAULT_SETTINGS);
  expect(classifyArticle).toHaveBeenCalledTimes(2);
  expect(plan.signature).toContain('新规则');
});
it('rejects a deleted root before any decision can be saved', async () => {
  vi.mocked(locateDocument).mockRejectedValue(new Error('根文档不存在'));
  await expect(prepareClassification('root', article, '正文', DEFAULT_SETTINGS)).rejects.toThrow('根文档不存在');
  expect(classifyArticle).not.toHaveBeenCalled();
});
it('reclassifies a removed candidate before the final write', async () => {
  const plan = await prepareClassification('root', article, '正文', DEFAULT_SETTINGS);
  vi.mocked(discoverCategories).mockResolvedValue([]);
  vi.mocked(classifyArticle).mockResolvedValue({ categoryId: null, confidence: 0, reason: '没有分类' });
  expect((await validateClassification(plan, article, '正文', DEFAULT_SETTINGS)).decision.categoryId).toBeNull();
});
it('stops if the rules keep changing, instead of using a stale destination', async () => {
  let changes = 0;
  vi.mocked(discoverCategories).mockImplementation(async () => [{ ...category, description: String(changes++) }]);
  await expect(prepareClassification('root', article, '正文', DEFAULT_SETTINGS)).rejects.toThrow('发生变化');
  expect(classifyArticle).toHaveBeenCalledTimes(2);
});

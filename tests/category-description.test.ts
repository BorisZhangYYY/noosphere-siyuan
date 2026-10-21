/** 描述区域和目录标题互不影响，模型只返回待确认的描述草稿。 */
import { beforeEach, expect, it, vi } from "vitest";
import { descriptionSection, readCategoryDescription } from "../src/siyuan/category-description";
import { generateCategoryDescription } from "../src/review/category-description";
import { requestShortText } from "../src/review/short-request";
import { DEFAULT_SETTINGS } from "../src/types";
vi.mock("../src/review/short-request", () => ({ requestShortText: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it("reads only the description section even when other prose or directory headings change", () => {
  for (const title of ['文章目录', '目录', '所有文章']) {
    expect(readCategoryDescription(`开头的其他说明\n\n## 分类描述\n\n收集 AI 与工具调用。\n\n## ${title}\n\n* ((20260101000000-aaaaaaa '文章'))\n\n## 用户备注\n\n不属于分类描述`, '旧描述')).toBe('收集 AI 与工具调用。');
  }
});
it("keeps a marked description section when its heading is renamed", () => {
  const md = '## 收录说明\n{: id="20260101000000-aaaaaaa" custom-zl-description="true"}\n\n新的正文描述\n\n## 目录\n\n目录后面的其他文字';
  expect(descriptionSection(md)?.headingId).toBe('20260101000000-aaaaaaa');
  expect(readCategoryDescription(md, '过期属性')).toBe('新的正文描述');
});
it("does not mistake fenced headings or an intentionally empty description for old prose", () => {
  expect(readCategoryDescription('```md\n## 分类描述\n错误区域\n```\n\n## 分类描述\n\n真正的描述\n\n## 目录')).toBe('真正的描述');
  expect(readCategoryDescription('## 分类描述\n\n## 目录', '过期描述')).toBe('');
});
it("generates editable text with existing classification boundaries and makes no document write", async () => {
  vi.mocked(requestShortText).mockResolvedValue('收集大型语言模型的训练、推理与 RAG；其他 AI 应用优先放到人工智能。');
  const result = await generateCategoryDescription('大模型', '人工智能', [{ id: 'id', name: '游戏', path: '游戏', description: '游戏机制', parentId: 'root' }], DEFAULT_SETTINGS);
  expect(result).toContain('RAG');
  expect(vi.mocked(requestShortText).mock.calls[0][2]).toContain('游戏机制');
});
it("requires a name and reports unusable model output", async () => {
  await expect(generateCategoryDescription('', '根', [], DEFAULT_SETTINGS)).rejects.toThrow('名称');
  expect(requestShortText).not.toHaveBeenCalled();
  vi.mocked(requestShortText).mockResolvedValue('');
  await expect(generateCategoryDescription('AI', '根', [], DEFAULT_SETTINGS)).rejects.toThrow('为空');
});

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
it("uses only the current category context and requests a focused, editable description", async () => {
  const text = '收集大型语言模型的训练、推理与 RAG，包含模型评测、技术实践和应用案例。';
  vi.mocked(requestShortText).mockResolvedValue(text);
  const controller = new AbortController();
  expect(await generateCategoryDescription(' 大模型 ', ' 人工智能 ', DEFAULT_SETTINGS, controller.signal)).toBe(text);
  const [settings, prompt, input, signal] = vi.mocked(requestShortText).mock.calls[0];
  expect(settings).toBe(DEFAULT_SETTINGS); expect(signal).toBe(controller.signal);
  expect(JSON.parse(input)).toEqual({ name: '大模型', parent: '人工智能' });
  expect(prompt).toContain('正向说明当前分类适合收录的主题、内容范围和典型文章');
  expect(prompt).toContain('不比较相邻分类');
  expect(prompt).toContain('不写排除条款');
});
it("requires a name and reports unusable model output", async () => {
  await expect(generateCategoryDescription('', '根', DEFAULT_SETTINGS)).rejects.toThrow('名称');
  expect(requestShortText).not.toHaveBeenCalled();
  vi.mocked(requestShortText).mockResolvedValue('');
  await expect(generateCategoryDescription('AI', '根', DEFAULT_SETTINGS)).rejects.toThrow('为空');
});

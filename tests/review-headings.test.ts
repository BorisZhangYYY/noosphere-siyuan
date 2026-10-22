/** 验证内置正文容器与原文章节的层级，不改写自定义版式或代码示例。 */
import { describe, expect, it } from "vitest";
import { nestReviewBodyHeadings } from "../src/review/headings";
import { parseReviewResult } from "../src/review/perspectives";
import { DEFAULT_SETTINGS } from "../src/types";

describe("审阅正文标题层级", () => {
  it.each([
    ["original", "正文"], ["novice", "正文与讲解"],
    ["original", "Body"], ["novice", "Body and explanations"],
  ])("将 %s 的 %s 内部章节整体降级并保留相对层级", (perspective, heading) => {
    const markdown = `## AI 摘要\n\n摘要。\n\n## ${heading}\n\n## 第一节\n\n### 子节\n\n## 总结\n\n正文总结。`;
    const expected = `## AI 摘要\n\n摘要。\n\n## ${heading}\n\n### 第一节\n\n#### 子节\n\n### 总结\n\n正文总结。`;
    expect(nestReviewBodyHeadings(markdown, perspective)).toBe(expected);
    expect(nestReviewBodyHeadings(expected, perspective)).toBe(expected);
  });

  it("代码、缩进和引用中的标题保持原样，已经正确嵌套的章节不改动", () => {
    const markdown = "## 正文\n\n````md\n## 代码标题\n```\n# 仍是代码\n````\n\n~~~text\n## 更多代码\n~~~\n\n    ## 缩进代码\n\n> ## 引用\n\n### 第一节\n\n#### 子节";
    expect(nestReviewBodyHeadings(markdown, "original")).toBe(markdown);
    expect(nestReviewBodyHeadings(markdown + "\n\n## 第二节", "original")).toBe(markdown.replace("### 第一节", "#### 第一节").replace("#### 子节", "##### 子节") + "\n\n### 第二节");
  });

  it("在实际审阅结果解析处修正结构，自定义版式和未生成正文容器的文章不套用", () => {
    const article = { url: "https://example.com/article", title: "文章", markdown: "## 第一节\n\n正文。" };
    const response = JSON.stringify({ title: "文章", markdown: "## 正文\n\n## 第一节\n\n正文。", summary: "摘要" });
    expect(parseReviewResult(response, article, DEFAULT_SETTINGS).markdown).toContain("## 正文\n\n### 第一节");
    const custom = { id: "custom", label: "自定义", description: "", prompt: "保留格式", template: "自由组织章节" };
    expect(parseReviewResult(response, article, { ...DEFAULT_SETTINGS, reviewPerspective: "custom", customPerspectives: [custom] }).markdown).toContain("## 正文\n\n## 第一节");
    expect(nestReviewBodyHeadings(article.markdown, "original")).toBe(article.markdown);
  });
});

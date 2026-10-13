/** 输出语言迁移、界面跟随与提示词优先级。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/types";
import { buildReviewPrompt } from "../src/review/perspectives";
import { normalizeOutputLanguage, resolveOutputLanguage } from "../src/review/language";

afterEach(() => vi.unstubAllGlobals());
describe("article output language", () => {
  it("migrates missing settings to following the interface", () => {
    expect(normalizeOutputLanguage(undefined)).toBe("follow_ui"); expect(normalizeOutputLanguage("invalid")).toBe("follow_ui");
    expect(resolveOutputLanguage("follow_ui", "en_US")).toBe("en-US"); expect(resolveOutputLanguage("follow_ui", "zh_CN")).toBe("zh-CN");
    expect(resolveOutputLanguage("zh-CN", "en_US")).toBe("zh-CN"); expect(resolveOutputLanguage("source", "zh_CN")).toBe("source");
  });
  it("uses the current SiYuan interface language in the actual review prompt", () => {
    vi.stubGlobal("window", { siyuan: { config: { lang: "en_US" } } });
    expect(buildReviewPrompt(DEFAULT_SETTINGS)).toContain("全部使用英文（English）");
    vi.stubGlobal("window", { siyuan: { config: { lang: "zh_CN" } } });
    expect(buildReviewPrompt(DEFAULT_SETTINGS)).toContain("全部使用简体中文");
  });
  it("applies the selected language to titles, section headings and additions while preserving source evidence", () => {
    const english = buildReviewPrompt({ ...DEFAULT_SETTINGS, outputLanguage: "en-US" });
    expect(english).toContain("章节名称、摘要、讲解、AI 补充和内部 summary 全部使用英文");
    expect(english).toContain("语言选择优先于视角和文章格式中的示例语言"); expect(english).toContain("元数据证据保留原样");
    expect(buildReviewPrompt({ ...DEFAULT_SETTINGS, outputLanguage: "source" })).toContain("保持抓取原文的主要语言");
  });
});

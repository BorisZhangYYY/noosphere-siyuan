/** 来源展示、历史时间兼容和流式正文的回归验证。 */
import { describe, expect, it } from "vitest";
import { composeArticle, stripSourceMetadata } from "../src/article/compose";
import { articleTime, restoreArticleTime } from "../src/article/time";
import { reviewPlaybackContent } from "../src/review/playback";
import { sourcePlatform } from "../src/article/source";

const article = { title: "标题", url: "https://example.com/article", markdown: "正文", author: "作者", publishedAt: "2026-10-12", capturedAt: "2026-10-14T01:00:00Z" };

describe("source metadata", () => {
  it("displays the WeChat platform name and keeps unrelated sites as their domain", () => {
    expect(sourcePlatform("https://mp.weixin.qq.com/s/article")).toBe("微信公众号");
    expect(sourcePlatform("https://example.com/article")).toBe("example.com");
    expect(sourcePlatform("invalid")).toBe("invalid");
  });
  it("keeps each field in a distinct quote paragraph and composes idempotently", () => {
    const content = composeArticle(article, "# 标题\n\n正文\n\n> 用户自己的引用");
    expect(content).toContain("> 作者：作者\n>\n> 发布时间：");
    expect(content).toContain("> 抓取时间：");
    expect(composeArticle(article, content)).toBe(content);
    expect(stripSourceMetadata(content)).toContain("> 用户自己的引用");
    expect(content.match(/来源：/g)).toHaveLength(1);
  });

  it("replaces legacy single-line metadata even when the URL changes", () => {
    const old = "# 标题\n\n> 来源：<https://old.example/article> · 作者：旧作者\n\n正文";
    const content = composeArticle(article, old);
    expect(content).not.toContain("old.example"); expect(content).not.toContain("旧作者");
    expect(content.match(/来源：/g)).toHaveLength(1);
  });

  it("removes all metadata from streaming playback but retains the real article quote", () => {
    const result = reviewPlaybackContent(composeArticle(article, "# 标题\n\n正文\n\n> 实际引用"), "备用标题");
    expect(result).toEqual({ title: "标题", markdown: "正文\n\n> 实际引用" });
  });

  it("uses legacy history time only as record time and preserves genuine capture time", () => {
    const legacy = restoreArticleTime({ ...article, capturedAt: undefined }, 1791858929095);
    expect(legacy.capturedAt).toBeUndefined(); expect(articleTime(legacy).label).toBe("记录时间（旧版本）");
    expect(composeArticle(legacy, "正文")).toContain("记录时间（旧版本）：");
    expect(restoreArticleTime(article, Date.now())).toBe(article);
    expect(articleTime({ ...article, capturedAt: "invalid" }).value).toBe("未记录");
  });
});

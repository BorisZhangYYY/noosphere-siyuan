/** 验证通用抓取请求、平台特例边界与保存的来源信息。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrapeWithFirecrawl } from "../src/crawler/firecrawl";
import { canonicalArticleUrl } from "../src/crawler/policy";
import { sourcePlatform } from "../src/article/source";

const articleUrl = "https://www.xiaoheihe.cn/app/bbs/link/5ec2720f605a";
const shareUrl = "https://api.xiaoheihe.cn/v3/bbs/app/api/web/share";

afterEach(() => vi.unstubAllGlobals());

/** 在思源代理边界捕获真实请求，既检查参数也检查返回文章的来源和正文。 */
function mockScrape(markdown = "文章正文"): ReturnType<typeof vi.fn> {
  const request = vi.fn(async (_path: string, _options: RequestInit) => ({
    ok: true,
    json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({
      success: true,
      data: { markdown, metadata: { title: "文章标题", author: "作者", publishedTime: "2026-10-20" } },
    }) } }),
  }));
  vi.stubGlobal("fetch", request);
  return request;
}

describe("通用抓取策略", () => {
  it.each([
    "https://example.com/article?ref=share#正文",
    "https://mp.weixin.qq.com/s/article",
    "https://www.zhihu.com/question/123/answer/456",
    articleUrl,
  ])("所有平台统一等待渲染且保留正常网址：%s", async rawUrl => {
    const request = mockScrape();
    const article = await scrapeWithFirecrawl(rawUrl, "test-key");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe("/api/network/forwardProxy");
    const proxy = JSON.parse(request.mock.calls[0][1].body as string);
    expect(proxy).toMatchObject({
      url: "https://api.firecrawl.dev/v2/scrape", method: "POST",
      headers: [{ Authorization: "Bearer test-key" }],
      payload: { url: new URL(rawUrl).href, formats: ["markdown"], onlyMainContent: true, waitFor: 5000 },
    });
    expect(article).toMatchObject({
      url: new URL(rawUrl).href, title: "文章标题", markdown: "文章正文", author: "作者", publishedAt: "2026-10-20",
    });
    expect(Number.isNaN(Date.parse(article.capturedAt!))).toBe(false);
  });

  it("链接转换前先拒绝登录凭据，避免转换后的地址绕过校验", async () => {
    const request = mockScrape();
    await expect(scrapeWithFirecrawl(shareUrl.replace("://", "://user:password@") + "?link_id=5ec2720f605a", "test-key"))
      .rejects.toThrow("文章链接不能包含登录凭据");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("小黑盒特例", () => {
  it.each(["0", "1"])("转换分享样式 %s，且抓取与保存使用同一正文地址", async style => {
    const request = mockScrape(`![](${articleUrl})\n\n正文与配图\n\n![配图](https://images.example.com/photo.png)`);
    const article = await scrapeWithFirecrawl(`${shareUrl}?h_session_id=session&h_src=share&link_id=5ec2720f605a&new_post_share_style_v2=${style}`, "test-key");
    const proxy = JSON.parse(request.mock.calls[0][1].body as string);
    expect(proxy.payload).toMatchObject({ url: articleUrl, waitFor: 5000 });
    expect(article.url).toBe(articleUrl);
    expect(article.markdown).toBe("正文与配图\n\n![配图](https://images.example.com/photo.png)");
    expect(sourcePlatform(article.url)).toBe("小黑盒");
  });

  it("接受已知分享路径的尾部斜杠，转换结果可重复使用", () => {
    const result = canonicalArticleUrl(new URL(`${shareUrl}/?link_id=5ec2720f605a`));
    expect(result.href).toBe(articleUrl);
    expect(canonicalArticleUrl(result).href).toBe(articleUrl);
  });

  it.each([
    `${shareUrl}?h_src=share`,
    `${shareUrl}?link_id=`,
    `${shareUrl}?link_id=abc%2Fother`,
    `${shareUrl}?link_id=..`,
    `${shareUrl}?link_id=abc%3Fnext%3D1`,
    `${shareUrl}?link_id=abc%23fragment`,
    `${shareUrl}?link_id=abc&link_id=def`,
    "https://api.xiaoheihe.cn/other?link_id=5ec2720f605a",
    "https://www.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=5ec2720f605a",
    `${articleUrl}?link_id=unrelated`,
    "https://xiaoheihe.cn.example.com/v3/bbs/app/api/web/share?link_id=5ec2720f605a",
    "https://example.com/article?link_id=5ec2720f605a",
  ])("保留不符合分享规则的网址：%s", rawUrl => {
    expect(canonicalArticleUrl(new URL(rawUrl)).href).toBe(new URL(rawUrl).href);
  });
});

describe("平台来源名称", () => {
  it.each([
    ["https://mp.weixin.qq.com/s/article", "微信公众号"],
    ["https://zhihu.com/question/123", "知乎"],
    ["https://zhuanlan.zhihu.com/p/123", "知乎"],
    [shareUrl + "?link_id=5ec2720f605a", "小黑盒"],
    [articleUrl, "小黑盒"],
    ["https://example.com/article", "example.com"],
    ["https://zhihu.com.example.com/p/123", "zhihu.com.example.com"],
    ["https://xiaoheihe.cn.example.com/article", "xiaoheihe.cn.example.com"],
    ["invalid", "invalid"],
  ])("%s 显示为 %s", (rawUrl, expected) => {
    expect(sourcePlatform(rawUrl)).toBe(expected);
  });
});

/** 抓取链接规整与前端渲染等待的回归验证。 */
import { describe, expect, it } from "vitest";
import { buildScrapePayload, canonicalArticleUrl } from "../src/crawler/platform";
import { parseArticleUrl } from "../src/crawler/firecrawl";
import { sourcePlatform } from "../src/article/source";

describe("crawler platform", () => {
  it("waits for client-side rendering before scraping", () => {
    const payload = buildScrapePayload(parseArticleUrl("https://example.com/article"));
    expect(payload.waitFor).toBe(5000);
    expect(payload.onlyMainContent).toBe(true);
  });

  it("resolves the xiaoheihe share link to the article page", () => {
    const share = parseArticleUrl("https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_session_id=LM6KRuvYPzJxtDs&h_src=YXBwX3NoYXJl&link_id=5ec2720f605a&new_post_share_style_v2=1");
    expect(canonicalArticleUrl(share).href).toBe("https://www.xiaoheihe.cn/app/bbs/link/5ec2720f605a");
  });

  it("keeps unrelated links and share links without an id untouched", () => {
    const wechat = parseArticleUrl("https://mp.weixin.qq.com/s/abc");
    expect(canonicalArticleUrl(wechat).href).toBe("https://mp.weixin.qq.com/s/abc");
    const noId = parseArticleUrl("https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link");
    expect(canonicalArticleUrl(noId).href).toBe("https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link");
  });

  it("shows the xiaoheihe platform name for both the share and the article address", () => {
    expect(sourcePlatform("https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=5ec2720f605a")).toBe("小黑盒");
    expect(sourcePlatform("https://www.xiaoheihe.cn/app/bbs/link/5ec2720f605a")).toBe("小黑盒");
  });
});

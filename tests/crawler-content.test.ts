/** 在实际抓取入口验证从原版迁入的 Markdown 规则，不依赖真实密钥或收费请求。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrapeWithFirecrawl } from "../src/crawler/firecrawl";

const wechatUrl = "https://mp.weixin.qq.com/s/article";
const shareUrl = "https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=5ec2720f605a";
const canonicalUrl = "https://www.xiaoheihe.cn/app/bbs/link/5ec2720f605a";
const zhihuUrl = "https://zhuanlan.zhihu.com/p/123";

interface Metadata {
  title?: string;
  author?: string;
  publishedTime?: string;
  statusCode?: number;
}

/** 返回 Firecrawl 的真实响应形状，记录思源代理发出的载荷供来源校验。 */
function mockCapture(markdown: string, metadata: Metadata = {}): ReturnType<typeof vi.fn> {
  const request = vi.fn(async (_path: string, _options: RequestInit) => ({
    ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ success: true, data: { markdown, metadata } }) } }),
  }));
  vi.stubGlobal("fetch", request);
  return request;
}

afterEach(() => vi.unstubAllGlobals());

describe("微信公众号内容整理", () => {
  it("从显式作者行与独立日期补全缺失元数据，并清理阅读器和尾部界面文案", async () => {
    mockCapture("Original吕倩吕倩\n第一财经\n\n_2026年7月22日 00:13_\n\n****作者 \\|**** 第一财经\u00a0吕倩\n\n在小说阅读器读本章\n去阅读\n在小说阅读器中沉浸阅读\n\n正文第一段。\n\n正文第二段。\n\n**·联系我们**\n\n推荐阅读\n\nSend Message\n\n写留言:\n\n## 确认提交投诉");
    const article = await scrapeWithFirecrawl(wechatUrl, "test-key");
    expect(article).toMatchObject({ author: "第一财经 吕倩", publishedAt: "2026年7月22日 00:13" });
    expect(article.markdown).toContain("正文第一段。");
    expect(article.markdown).toContain("正文第二段。");
    for (const noise of ["Original", "小说阅读器", "去阅读", "联系我们", "推荐阅读", "Send Message", "写留言", "确认提交投诉"]) {
      expect(article.markdown).not.toContain(noise);
    }
  });

  it("已有元数据优先，缺失字段独立补全并支持 ISO 日期", async () => {
    mockCapture("作者：正文作者\n\n2026-10-20T08:30\n\n正文。", { author: "已抓到的作者" });
    expect(await scrapeWithFirecrawl(wechatUrl, "test-key"))
      .toMatchObject({ author: "已抓到的作者", publishedAt: "2026-10-20T08:30" });
    mockCapture("作者：正文作者\n\n2026-10-20\n\n正文。", { publishedTime: "2026-10-19" });
    expect(await scrapeWithFirecrawl(wechatUrl, "test-key"))
      .toMatchObject({ author: "正文作者", publishedAt: "2026-10-19" });
  });

  it("重复封面横幅使用微信图片身份匹配，只移除重复项并保留正文配图", async () => {
    const banner = "https://mmbiz.qpic.cn/mmbiz_png/cover/300?wx_fmt=png";
    const cover = "http://mmbiz.qpic.cn/mmbiz_png/cover/0?wxfrom=19";
    mockCapture(`### ![](${banner})\n\n### **媒体报道**\n\n![封面](${cover})\n\n正文。\n\n![配图](https://images.example.com/body.png)`);
    const article = await scrapeWithFirecrawl(wechatUrl, "test-key");
    expect(article.markdown).not.toContain(banner);
    expect(article.markdown).toContain(`![封面](${cover})`);
    expect(article.markdown).toContain("![配图](https://images.example.com/body.png)");
  });

  it("唯一配图即使后接短标题也不移除；重复横幅至少保留一份", async () => {
    const image = "https://images.example.com/banner.png";
    mockCapture(`### ![](${image})\n\n### **媒体报道**\n\n短文章。`);
    expect((await scrapeWithFirecrawl(wechatUrl, "test-key")).markdown).toContain(image);
    mockCapture(`### ![](${image})\n\n### **媒体报道**\n\n### ![](${image})\n\n### **媒体报道**\n\n短文章。`);
    expect((await scrapeWithFirecrawl(wechatUrl, "test-key")).markdown.match(/!\[\]/g)).toHaveLength(1);
  });

  it("代码、引用和正常段落中的相同文案保留，且不用于补全元数据", async () => {
    const markdown = "# 教程\n\nOriginal research is valuable.\n\n这里解释推荐阅读的用途。\n\n微信编辑功能是本文讨论的主题。\n\n````md\n作者：代码作者\n2026-01-01\n推荐阅读\n```\n去阅读\n````\n\n~~~text\nSend Message\n~~~\n\n> 确认提交投诉\n> 作者：引用作者\n\n    去阅读\n\n结尾正文。";
    mockCapture(markdown);
    const article = await scrapeWithFirecrawl(wechatUrl, "test-key");
    expect(article.markdown).toBe(markdown);
    expect(article.author).toBeUndefined();
    expect(article.publishedAt).toBeUndefined();
  });

  it("清理后只有阅读器噪声时报告抓取失败", async () => {
    mockCapture("在小说阅读器读本章\n去阅读\n在小说阅读器中沉浸阅读");
    await expect(scrapeWithFirecrawl(wechatUrl, "test-key")).rejects.toThrow("Firecrawl 未返回正文");
  });
});

describe("小黑盒链接与标题整理", () => {
  it.each(["https://xiaoheihe.cn/bbs/post_share", "https://www.xiaoheihe.cn/bbs/post_share/"])("兼容旧版分享入口 %s", async url => {
    const request = mockCapture("正文。", { title: "文章标题 - 小黑盒" });
    const article = await scrapeWithFirecrawl(`${url}?link_id=5ec2720f605a&h_session_id=session`, "test-key");
    expect(article).toMatchObject({ url: canonicalUrl, title: "文章标题", markdown: "正文。" });
    expect(JSON.parse(request.mock.calls[0][1].body as string).payload).toMatchObject({ url: canonicalUrl, waitFor: 5000 });
  });

  it("保留原分享参数补全缺失标题，保存的地址不携带会话或分享数据", async () => {
    const request = mockCapture("真正抓到的完整正文。");
    const data = encodeURIComponent(JSON.stringify({ link: { title: "分享标题 - 小黑盒", description: "分享摘要" } }));
    const article = await scrapeWithFirecrawl(`${shareUrl}&h_session_id=session&redirect_data=${data}`, "test-key");
    expect(article).toMatchObject({ url: canonicalUrl, title: "分享标题", markdown: "真正抓到的完整正文。" });
    expect(JSON.parse(request.mock.calls[0][1].body as string).payload.url).toBe(canonicalUrl);
  });

  it("实际元数据标题优先，其次使用正文中的真正一级标题", async () => {
    const data = encodeURIComponent(JSON.stringify({ link: { title: "分享标题" } }));
    const markdown = "~~~md\n# 代码标题\n~~~\n\n    # 缩进代码标题\n\n# 正文标题 - 小黑盒\n\n正文。";
    mockCapture(markdown, { title: "实际标题 - 小黑盒" });
    expect((await scrapeWithFirecrawl(`${shareUrl}&redirect_data=${data}`, "test-key")).title).toBe("实际标题");
    mockCapture(markdown);
    expect((await scrapeWithFirecrawl(`${shareUrl}&redirect_data=${data}`, "test-key")).title).toBe("正文标题");
  });

  it.each(["{bad json", "null", "[]", '{"link":null}', '{"link":{"title":42}}'])("异常分享数据不影响已抓到的正文：%s", async data => {
    mockCapture("短正文。");
    const article = await scrapeWithFirecrawl(`${shareUrl}&redirect_data=${encodeURIComponent(data)}`, "test-key");
    expect(article).toMatchObject({ title: "www.xiaoheihe.cn", markdown: "短正文。" });
  });

  it("识别作者卡片后移除页面外壳、评论与推荐，保留全文、投票和文章配图", async () => {
    const avatar = "https://imgheybox.max-c.com/avatar/2026/10/18/avatar.jpeg";
    const profile = "https://www.xiaoheihe.cn/app/user/profile/123";
    const picture = "![配图](https://imgheybox.max-c.com/bbs/2026/10/18/article.png)";
    const card = `[![](${avatar})\n\n文章作者\n\nLv.13\n\n10-18\n\n·福建](${profile}) 关注`;
    const body = `开头正文。\n\n${picture}\n\n## 最后章节\n\n结尾正文。\n\n下一期单选111人参与\n\n已结束`;
    const topic = "![](https://imgheybox.max-c.com/oa/topic.png)话题一![](https://imgheybox.max-c.com/oa/topic.png)话题二";
    const markdown = `返回\n\n[![](${avatar})\\n文章作者](${profile}) 关注\n\n文章标题\n\n${card}\n\n![](https://imgheybox1.max-c.com/web/game.webp)游戏名称\n\n${body}\n\n${topic}\n\n全部评论\n\n6\n\n[![](${avatar})](${profile})\n\n评论内容\n\n相似内容\n\n立即下载小黑盒APP`;
    mockCapture(markdown, { title: "文章标题 - 小黑盒" });
    const article = await scrapeWithFirecrawl(shareUrl, "test-key");
    expect(article).toMatchObject({ title: "文章标题", author: "文章作者", publishedAt: "10-18", markdown: body });
    mockCapture(markdown.replace(body, ""), { title: "文章标题" });
    await expect(scrapeWithFirecrawl(shareUrl, "test-key")).rejects.toThrow("Firecrawl 未返回正文");
    mockCapture(markdown, { title: "文章标题", author: "元数据作者", publishedTime: "2026-10-18" });
    expect(await scrapeWithFirecrawl(shareUrl, "test-key")).toMatchObject({ author: "元数据作者", publishedAt: "2026-10-18" });
  });

  it("卡片相对日期不推算绝对时间；正文里的代码、引用和同名段落不作为评论边界", async () => {
    const avatar = "https://imgheybox.max-c.com/avatar/a.jpeg";
    const profile = "https://www.xiaoheihe.cn/app/user/profile/123";
    const card = `[![](${avatar})\n作者\nLv.13\n3天前\n·福建](${profile}) 关注`;
    const commentSample = `全部评论\n\n6\n\n[![](${avatar})](${profile})`;
    const body = `开头。\n\n\`\`\`\`md\n${commentSample}\n\`\`\`\`\n\n> 全部评论\n\n全部评论\n\n这是文章介绍的功能，不是平台评论区。\n\n结尾。`;
    mockCapture(`返回\n\n文章标题\n\n${card}\n\n${body}`, { title: "文章标题" });
    const article = await scrapeWithFirecrawl(shareUrl, "test-key");
    expect(article.markdown).toBe(body);
    expect(article.publishedAt).toBeUndefined();
    mockCapture(`文章标题\n\n${card}\n\n${body}`, { title: "文章标题" });
    expect((await scrapeWithFirecrawl(shareUrl, "test-key")).markdown).toContain(card);
  });

  it("仅有分享描述而没有正文时继续报告失败", async () => {
    mockCapture("");
    const data = encodeURIComponent(JSON.stringify({ link: { title: "分享标题", description: "只有摘要不能冒充正文" } }));
    await expect(scrapeWithFirecrawl(`${shareUrl}&redirect_data=${data}`, "test-key")).rejects.toThrow("Firecrawl 未返回正文");
  });
});

describe("知乎访问页校验", () => {
  it.each([
    ["![Logo](https://images.example.com/logo.png)\n\n请您登录后查看更多专业优质内容。", 200],
    ["[登录后查看全文](https://www.zhihu.com/signin)", 200],
    ["安全验证", 200],
    ["请求异常", 200],
    ["Access denied", 401],
    ["Access denied", 403],
    ["Rate limited", 429],
    ["", 403],
  ])("拒绝访问页 %s（原站状态 %s）", async (markdown, statusCode) => {
    const request = mockCapture(markdown as string, { statusCode: statusCode as number });
    await expect(scrapeWithFirecrawl(zhihuUrl, "test-key")).rejects.toThrow("知乎未返回文章正文");
    expect(request).toHaveBeenCalledOnce();
  });

  it("完整文章引用访问提示时保留正文，正常短文也不设字数门槛", async () => {
    const markdown = "# 文章\n\n" + "完整正文讨论网页访问与内容抓取。".repeat(70) + "\n\n请您登录后查看更多专业优质内容。";
    mockCapture(markdown, { title: "文章", statusCode: 200 });
    expect((await scrapeWithFirecrawl(zhihuUrl, "test-key")).markdown).toBe(markdown);
    mockCapture("一段正常短文。", { statusCode: 200 });
    expect((await scrapeWithFirecrawl(zhihuUrl, "test-key")).markdown).toBe("一段正常短文。");
  });
});

it("未知站点不套用其他平台的清理与访问墙判断", async () => {
  const markdown = "作者：正文作者\n\n推荐阅读\n\n登录后阅读全文\n\n去阅读";
  const request = mockCapture(markdown, { title: "普通文章 - 小黑盒" });
  const article = await scrapeWithFirecrawl("https://example.com/article", "test-key");
  expect(article).toMatchObject({ markdown, title: "普通文章 - 小黑盒" });
  expect(article.author).toBeUndefined();
  expect(JSON.parse(request.mock.calls[0][1].body as string).payload.waitFor).toBe(5000);
});

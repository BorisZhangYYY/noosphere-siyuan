/** 抓取前处理：把分享链接规整成正文页地址，并决定 Firecrawl 需要等多久。 */

/** Firecrawl 等待前端渲染的时长（毫秒）。正文由 JS 异步渲染的站点必须等待，否则只能抓到首屏框架。 */
export const RENDER_WAIT_MS = 5000;

/** 小黑盒分享链接（api.xiaoheihe.cn/.../share?link_id=xxx）先 302 跳到正文页，这里直接给出正文页地址。 */
export function canonicalArticleUrl(url: URL): URL {
  if (!/(^|\.)xiaoheihe\.cn$/.test(url.hostname)) return url;
  const linkId = url.searchParams.get("link_id");
  if (!linkId) return url;
  return new URL(`https://www.xiaoheihe.cn/app/bbs/link/${linkId}`);
}

/** 交给 Firecrawl 的抓取参数：等待渲染完成，避免只拿到页面框架或页脚。 */
export function buildScrapePayload(url: URL): { url: string; formats: string[]; onlyMainContent: boolean; waitFor: number } {
  return { url: url.href, formats: ["markdown"], onlyMainContent: true, waitFor: RENDER_WAIT_MS };
}

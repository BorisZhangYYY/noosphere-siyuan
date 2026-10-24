/** 通用抓取策略：未知站点沿用默认参数，已验证的例外交由各平台维护。 */
import { resolvePlatform } from "./platforms";
import type { CaptureResult } from "./platforms/types";

/** 交由 Firecrawl 在正文抽取前统一等待渲染，不在本地额外延迟请求。 */
export const RENDER_WAIT_MS = 5000;

export interface ScrapePayload {
  url: string;
  formats: ["markdown"];
  onlyMainContent: boolean;
  waitFor: number;
}

/** 只有已登记且符合平台条件的链接才转换，其余链接原样保留。 */
export function canonicalArticleUrl(url: URL): URL {
  return resolvePlatform(url)?.canonicalArticleUrl?.(url) ?? url;
}

/** 所有平台统一等待 5 秒，不维护平台单独的等待分支。 */
export function buildScrapePayload(url: URL): ScrapePayload {
  return { url: url.href, formats: ["markdown"], onlyMainContent: true, waitFor: RENDER_WAIT_MS };
}

/** 先拒绝访问墙等无效响应，再整理正文与元数据；保留原始分享 URL 供元数据补全。 */
export function prepareCapture(originalUrl: URL, capture: CaptureResult): CaptureResult {
  const platform = resolvePlatform(originalUrl);
  platform?.validateCapture?.(capture);
  return platform?.processCapture?.(capture, originalUrl) ?? capture;
}

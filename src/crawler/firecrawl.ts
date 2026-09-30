/** Firecrawl v2 scraper adapter. */
import { proxyRequest } from "../siyuan/api";
import type { Article } from "../types";

interface FirecrawlResult {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: { title?: string; author?: string; publishedTime?: string; sourceURL?: string };
  };
  error?: string;
}

export function parseArticleUrl(raw: string): URL {
  const url = new URL(raw.trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只支持 HTTP 或 HTTPS 文章链接");
  if (url.username || url.password) throw new Error("文章链接不能包含登录凭据");
  return url;
}

/** Return a normalized Markdown article and its source metadata. */
export async function scrapeWithFirecrawl(rawUrl: string, apiKey: string): Promise<Article> {
  if (!apiKey.trim()) throw new Error("请先填写 Firecrawl API Key");
  const url = parseArticleUrl(rawUrl);
  const response = await proxyRequest(
    "https://api.firecrawl.dev/v2/scrape",
    "POST",
    { Authorization: `Bearer ${apiKey.trim()}` },
    { url: url.href, formats: ["markdown"], onlyMainContent: true },
  );
  const result = JSON.parse(response.body) as FirecrawlResult;
  if (result.success === false || !result.data?.markdown?.trim()) {
    throw new Error(result.error || "Firecrawl 未返回正文");
  }
  return {
    url: url.href,
    title: result.data.metadata?.title?.trim() || url.hostname,
    markdown: result.data.markdown.trim(),
    author: result.data.metadata?.author,
    publishedAt: result.data.metadata?.publishedTime,
  };
}

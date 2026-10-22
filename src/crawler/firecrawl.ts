/** Firecrawl v2 scraper adapter. */
import { proxyRequest } from "../siyuan/api";
import type { Article } from "../types";
import { stripArticleImagePlaceholders } from "../images/reference";
import { buildScrapePayload, canonicalArticleUrl, prepareCapture } from "./policy";

interface FirecrawlResult {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: { title?: string; author?: string; publishedTime?: string; sourceURL?: string; statusCode?: number };
  };
  error?: string;
}

export function parseArticleUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); }
  catch { throw new Error("请输入完整的文章链接，例如 https://example.com/article"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只支持 HTTP 或 HTTPS 文章链接");
  if (url.username || url.password) throw new Error("文章链接不能包含登录凭据");
  return url;
}

/** Return a normalized Markdown article and its source metadata. */
export async function scrapeWithFirecrawl(rawUrl: string, apiKey: string): Promise<Article> {
  if (!apiKey.trim()) throw new Error("请先填写 Firecrawl API Key");
  const originalUrl = parseArticleUrl(rawUrl);
  const url = canonicalArticleUrl(originalUrl);
  const response = await proxyRequest(
    "https://api.firecrawl.dev/v2/scrape",
    "POST",
    { Authorization: `Bearer ${apiKey.trim()}` },
    buildScrapePayload(url),
  );
  const result = JSON.parse(response.body) as FirecrawlResult;
  if (result.success === false || !result.data) {
    throw new Error(result.error || "Firecrawl 未返回正文");
  }
  const capture = prepareCapture(originalUrl, {
    markdown: result.data.markdown || "",
    title: result.data.metadata?.title?.trim() || undefined,
    author: result.data.metadata?.author?.trim() || undefined,
    publishedAt: result.data.metadata?.publishedTime?.trim() || undefined,
    statusCode: result.data.metadata?.statusCode,
  });
  const markdown = stripArticleImagePlaceholders(capture.markdown, url.href).trim();
  if (!markdown) throw new Error(result.error || "Firecrawl 未返回正文");
  return {
    url: url.href,
    title: capture.title || url.hostname,
    markdown,
    author: capture.author,
    publishedAt: capture.publishedAt,
    capturedAt: new Date().toISOString(),
  };
}

/** 区分真实抓取时间与旧版本的历史记录时间，不把迁移时间伪装成抓取时间。 */
import type { Article } from "../types";

export function validArticleTime(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && Number.isFinite(Date.parse(value));
}

/** 恢复旧记录的可用时间；真实抓取时间始终优先且不会被编辑时间覆盖。 */
export function restoreArticleTime(article: Article, recordedAt?: number): Article {
  if (validArticleTime(article.capturedAt) || validArticleTime(article.recordedAt)) return article;
  return Number.isFinite(recordedAt) && recordedAt! > 0
    ? { ...article, recordedAt: new Date(recordedAt!).toISOString() } : article;
}

export function articleTime(article: Article): { label: string; value: string } {
  const captured = validArticleTime(article.capturedAt);
  const value = captured ? article.capturedAt : article.recordedAt;
  return { label: captured || !validArticleTime(value) ? "抓取时间" : "记录时间（旧版本）",
    value: validArticleTime(value) ? new Date(value).toLocaleString(undefined, { hour12: false }) : "未记录" };
}

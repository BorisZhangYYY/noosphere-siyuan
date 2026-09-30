/** Assemble imported content without modifying the captured source article. */
import type { Article } from "../types";

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/([\\`*_{}\[\]()#+.!>|-])/g, "\\$1");
}

export function composeArticle(article: Article, markdown: string): string {
  const metadata = [`来源：<${article.url}>`];
  if (article.author) metadata.push(`作者：${singleLine(article.author)}`);
  if (article.publishedAt) metadata.push(`发布时间：${singleLine(article.publishedAt)}`);
  const body = markdown.trim();
  const firstHeading = body.match(/^(#{1,6} .+)\n+/);
  if (firstHeading) {
    return `${firstHeading[1]}\n\n> ${metadata.join(" · ")}\n\n${body.slice(firstHeading[0].length).trim()}\n`;
  }
  return `## ${singleLine(article.title)}\n\n> ${metadata.join(" · ")}\n\n${body}\n`;
}

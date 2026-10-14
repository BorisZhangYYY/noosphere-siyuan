/** Assemble imported content without modifying the captured source article. */
import type { Article } from "../types";
import { articleTime } from "./time";

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/([\\`*_{}\[\]()#+.!>|-])/g, "\\$1");
}

/** 每个字段单独成为引用段落，思源渲染后仍保持分行。 */
export function sourceMetadata(article: Article): string {
  const metadata = [`来源：<${article.url}>`];
  if (article.author) metadata.push(`作者：${singleLine(article.author)}`);
  if (article.publishedAt) metadata.push(`发布时间：${singleLine(article.publishedAt)}`);
  const time = articleTime(article);
  if (time.value !== "未记录") metadata.push(`${time.label}：${singleLine(time.value)}`);
  return `> ${metadata.join("\n>\n> ")}`;
}

/** 仅替换正文开头的系统来源引用，兼容原有单行和新的多行格式。 */
export function stripSourceMetadata(markdown: string): string {
  const body = markdown.trim();
  const heading = body.match(/^(#{1,6} .+)(?:\n+|$)/);
  const content = heading ? body.slice(heading[0].length).trim() : body;
  const cleaned = content.replace(/^>\s*来源：<[^>\n]+>[^\n]*(?:\n>[^\n]*)*(?:\n+|$)/, "").trim();
  return heading ? `${heading[1]}${cleaned ? `\n\n${cleaned}` : ""}` : cleaned;
}

export function composeArticle(article: Article, markdown: string): string {
  const metadata = sourceMetadata(article);
  const body = stripSourceMetadata(markdown);
  const firstHeading = body.match(/^(#{1,6} .+)(?:\n+|$)/);
  if (firstHeading) {
    const content = body.slice(firstHeading[0].length).trim();
    return `${firstHeading[1]}\n\n${metadata}\n\n${content}\n`;
  }
  return `## ${singleLine(article.title)}\n\n${metadata}\n\n${body}\n`;
}

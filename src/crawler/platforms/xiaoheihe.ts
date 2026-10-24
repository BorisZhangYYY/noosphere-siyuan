/** 小黑盒的分享链接与标题整理；正文仍以 Firecrawl 返回内容为准。 */
import type { CaptureResult, PlatformPolicy } from "./types";

/** 仅转换已知分享入口和有效文章 ID，避免误改其他页面或携带会话参数。 */
function canonicalArticleUrl(url: URL): URL {
  const apiShare = url.hostname === "api.xiaoheihe.cn" && /^\/v3\/bbs\/app\/api\/web\/share\/?$/.test(url.pathname);
  const legacyShare = ["www.xiaoheihe.cn", "xiaoheihe.cn"].includes(url.hostname) && /^\/bbs\/post_share\/?$/.test(url.pathname);
  if (!apiShare && !legacyShare) return url;
  const ids = url.searchParams.getAll("link_id");
  if (ids.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(ids[0])) return url;
  return new URL(`https://www.xiaoheihe.cn/app/bbs/link/${ids[0]}`);
}

/** 分享参数只用于补全缺失标题，不把描述冒充完整正文。 */
function redirectTitle(url: URL): string | undefined {
  try {
    const data: unknown = JSON.parse(url.searchParams.get("redirect_data") || "null");
    if (!data || typeof data !== "object" || !("link" in data)) return undefined;
    const link = data.link;
    return link && typeof link === "object" && "title" in link && typeof link.title === "string" ? link.title : undefined;
  } catch { return undefined; }
}

/** 标题回退只读真正的一级标题，跳过围栏与缩进代码中的示例。 */
function markdownTitle(markdown: string): string | undefined {
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (!fence && /^ {0,3}#\s+\S/.test(line)) return line.trim().replace(/^#\s+/, "").replace(/\s+#+\s*$/, "");
  }
  return undefined;
}

function cleanTitle(title?: string): string | undefined {
  return title?.trim().replace(/ - 小黑盒$/, "").trim() || undefined;
}

/** 只识别页面开头的作者卡片，正文示例和评论中的用户链接不作为来源。 */
function articleCard(markdown: string, title?: string): { end: number; author: string; publishedAt?: string } | undefined {
  if (!title || !markdown.startsWith("返回\n")) return undefined;
  const cards = markdown.matchAll(/\[!\[[^\]]*\]\(https:\/\/imgheybox\d*\.max-c\.com\/avatar\/[^\s)]+\)([\s\S]{0,500}?)\]\(https:\/\/www\.xiaoheihe\.cn\/app\/user\/profile\/\d+\)[ \t]*关注/g);
  for (const card of cards) {
    if (card.index > 1500) break;
    const fields = card[1].split(/\r?\n/).map((line: string): string => line.replace(/\\+$/, "").trim()).filter(Boolean);
    if (fields.length < 2 || !/^Lv\.\d+$/.test(fields[1]) || !markdown.slice(0, card.index).includes(title)) continue;
    // 页面可能只提供月日或相对日期；只保留显式日期，不推测年份或时间。
    const publishedAt = /^(?:\d{4}-)?\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2})?$/.test(fields[2] ?? "") ? fields[2] : undefined;
    return { end: card.index + card[0].length, author: fields[0], publishedAt };
  }
  return undefined;
}

/** 仅在确认网页作者卡片后清理外壳，保留文章配图、投票和所有正文段落。 */
function cleanArticle(markdown: string, start: number): string {
  let body = markdown.slice(start).trim();
  // 作者卡片后紧邻的游戏封面是平台关联入口，非文章插图。
  body = body.replace(/^!\[[^\]]*\]\(https:\/\/imgheybox\d*\.max-c\.com\/web\/[^\s)]+\)[^\n]+(?:\n|$)/, "").trim();
  const lines = body.split(/\r?\n/);
  let fence: string | undefined;
  const tail = lines.findIndex((line: string, index: number): boolean => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return false;
    }
    if (fence || line.trim() !== "全部评论") return false;
    const following = lines.slice(index + 1).join("\n").trimStart();
    // 评论标题、数量和平台头像组合才是边界，避免截掉文章中的同名标题或引用。
    return /^\d+\s+\[!\[[^\]]*\]\(https:\/\/imgheybox\d*\.max-c\.com\/avatar\//.test(following);
  });
  const content = tail < 0 ? lines : lines.slice(0, tail);
  while (content.length && !content[content.length - 1].trim()) content.pop();
  // 紧邻评论区的重复话题图标属于平台标签，不能当作文章配图。
  if (tail >= 0 && /^(?:!\[[^\]]*\]\(https:\/\/imgheybox\d*\.max-c\.com\/oa\/[^\s)]+\)[^!]+){2,}$/.test(content[content.length - 1] ?? "")) content.pop();
  return content.join("\n").trim();
}

/** 已抓到的元数据优先；仅从确认的正文和网页作者卡片补全缺失字段。 */
function processCapture(capture: CaptureResult, originalUrl: URL): CaptureResult {
  const title = cleanTitle(capture.title) || cleanTitle(markdownTitle(capture.markdown)) || cleanTitle(redirectTitle(originalUrl));
  const card = articleCard(capture.markdown, title);
  return { ...capture, title, author: capture.author || card?.author, publishedAt: capture.publishedAt || card?.publishedAt,
    markdown: card ? cleanArticle(capture.markdown, card.end) : capture.markdown };
}

export const xiaoheihe: PlatformPolicy = {
  sourceName: "小黑盒",
  matches: (url: URL): boolean => /(^|\.)xiaoheihe\.cn$/.test(url.hostname),
  canonicalArticleUrl,
  processCapture,
};

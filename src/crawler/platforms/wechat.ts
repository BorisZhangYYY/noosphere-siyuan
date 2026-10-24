/** 微信公众号的 Markdown 元数据补全和界面噪声清理。 */
import { imageIdentity } from "../../images/reference";
import type { CaptureResult, PlatformPolicy } from "./types";

const READER_NOISE = new Set(["在小说阅读器读本章", "去阅读", "在小说阅读器中沉浸阅读"]);
const TAIL_MARKERS = new Set(["Send Message", "写留言:", "写留言：", "确认提交投诉", "·联系我们", "推荐阅读"]);

/** 只简化行内展示标记，保留代码和引用内容供后续检查决定是否处理。 */
function plainLine(line: string): string {
  return line.trim().replace(/^#{1,6}\s+/, "").replace(/\*+/g, "").replace(/^_+|_+$/g, "").replace(/\\\|/g, "|").trim();
}

/** 围栏、缩进代码和引用中的平台提示可能是原文示例，不能当作界面噪声。 */
function protectedLines(lines: string[]): boolean[] {
  let fence: string | undefined;
  return lines.map((line: string): boolean => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return true;
    }
    return !!fence || /^(?: {4}|\t| {0,3}>)/.test(line);
  });
}

/** 清理已知阅读器与尾部界面文案；封面横幅仅在确有重复图片时移除。 */
function cleanBody(lines: string[], protectedLine: boolean[]): string {
  const minimumTailIndex = Math.min(20, Math.floor(lines.length * 0.2));
  const tail = lines.findIndex((line: string, index: number): boolean => {
    if (protectedLine[index] || index < minimumTailIndex) return false;
    const marker = plainLine(line);
    return TAIL_MARKERS.has(marker) || /^微信编辑(?:$|[\s:：|丨])/.test(marker);
  });
  const body = tail < 0 ? lines : lines.slice(0, tail);
  const imageCounts = new Map<string, number>();
  body.forEach((line: string, index: number): void => {
    if (protectedLine[index]) return;
    for (const match of line.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)) {
      const key = imageIdentity(match[1]);
      imageCounts.set(key, (imageCounts.get(key) ?? 0) + 1);
    }
  });
  return body.filter((line: string, index: number): boolean => {
    if (protectedLine[index]) return true;
    const plain = plainLine(line);
    if (READER_NOISE.has(plain) || (index < 5 && /^Original\S+$/.test(line.trim()))) return false;
    const banner = /^#{1,3}\s*!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)\s*$/.exec(line.trim());
    if (!banner || (imageCounts.get(imageIdentity(banner[1])) ?? 0) < 2) return true;
    for (let next = index + 1; next < Math.min(index + 6, body.length); next++) {
      const candidate = body[next].trim();
      if (!candidate) continue;
      if (protectedLine[next]) break;
      if (/^#{1,3}\s*(?:\*\*)?[^*#\n]{1,15}(?:\*\*)?\s*$/.test(candidate)) {
        const key = imageIdentity(banner[1]);
        imageCounts.set(key, imageCounts.get(key)! - 1);
        return false;
      }
      break;
    }
    return true;
  }).join("\n");
}

/** Firecrawl 元数据优先，仅从非代码、非引用的显式作者行和独立日期行补缺。 */
function processCapture(capture: CaptureResult): CaptureResult {
  const lines = capture.markdown.split(/\r\n|\r|\n/);
  const protectedLine = protectedLines(lines);
  const metadataLines = lines.filter((_line: string, index: number): boolean => !protectedLine[index]).map(plainLine);
  const author = metadataLines.map((line: string): string | undefined => /^作者\s*(?:\||[:：])\s*(.+?)\s*$/.exec(line)?.[1])
    .find((value: string | undefined): boolean => !!value)?.replace(/\s+/g, " ").trim();
  const publishedAt = metadataLines.find((line: string): boolean =>
    /^(?:\d{4}年\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2})(?:[ T]+\d{1,2}:\d{2})?$/.test(line));
  return { ...capture, author: capture.author || author, publishedAt: capture.publishedAt || publishedAt,
    markdown: cleanBody(lines, protectedLine) };
}

export const wechat: PlatformPolicy = {
  sourceName: "微信公众号",
  matches: (url: URL): boolean => url.hostname === "mp.weixin.qq.com",
  processCapture,
};

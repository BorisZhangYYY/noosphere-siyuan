/** Conservative image review adapted from Noosphere's image_filter workflow. */
import { proxyRequest } from "../siyuan/api";
import type { Article, Settings } from "../types";
import { modelEndpoint } from "./endpoint";

const IMAGE = /!\[([^\]]*)\]\((<?[^\s)]+>?)(?:\s+"[^"]*")?\)/g;
const MAX_IMAGES = 12;
const MAX_BASE64 = 8_400_000;
const PROMPT = `你正在审阅文章图片。只返回 JSON：{"classification":"RELEVANT"或"PROMOTION","description":"一句简短客观的图片描述"}。
保留代码和界面截图、技术图、图表、与正文相关的照片或插画。仅在确定图片是二维码、关注订阅图、广告横幅或无关占位装饰时标记 PROMOTION。混合内容、证据不足或无法确定时标记 RELEVANT。不要凭图片修改文章事实。`;

interface ImageRef { full: string; raw: string; alt: string; url: string }
export interface ImageDecision { full: string; alt: string; url: string; description: string; recommendedRemove: boolean; remove: boolean }
export interface ImageReviewResult { decisions: ImageDecision[]; reviewed: number; warnings: string[] }

function refs(markdown: string, articleUrl: string): ImageRef[] {
  return [...markdown.matchAll(IMAGE)].map(match => {
    const raw = match[2].replace(/^<|>$/g, "");
    let url = "";
    try { url = new URL(raw, articleUrl).href; } catch { /* Keep the original reference. */ }
    return { full: match[0], raw, alt: match[1], url };
  });
}

function responseText(body: string, format: Settings["modelFormat"]): string {
  const data = JSON.parse(body) as any;
  if (format === "anthropic") return data.content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n") || "";
  if (format === "openai_responses") return data.output_text || data.output?.flatMap((item: any) => item.content || []).filter((item: any) => item.type === "output_text").map((item: any) => item.text).join("\n") || "";
  if (format === "google") return data.candidates?.[0]?.content?.parts?.map((item: any) => item.text || "").join("\n") || "";
  const content = data.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n") || "";
}

async function classify(ref: ImageRef, article: Article, summary: string, settings: Settings): Promise<{ classification: "RELEVANT" | "PROMOTION"; description: string }> {
  const imageUrl = new URL(ref.url);
  if (!["http:", "https:"].includes(imageUrl.protocol)) throw new Error("图片地址不是 HTTP 链接");
  const downloaded = await proxyRequest(imageUrl.href, "GET", {}, undefined, "base64");
  const mime = downloaded.contentType.split(";")[0].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)) throw new Error(`模型暂不支持 ${mime || "未知"} 图片格式`);
  if (downloaded.body.length > MAX_BASE64) throw new Error("图片超过 6 MB 识别限制");
  const context = `文章标题：${article.title}\n审阅后摘要：${summary}\n图片说明：${ref.alt || "无"}\n请结合审阅后的文章判断图片是否相关。`;
  const base64 = downloaded.body;
  let endpoint: string;
  let payload: object;
  if (settings.modelFormat === "anthropic") {
    endpoint = modelEndpoint(settings.modelBaseUrl, "/messages", settings.modelFormat);
    payload = { model: settings.modelName.trim(), max_tokens: 256, system: PROMPT, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mime, data: base64 } }, { type: "text", text: context }] }] };
  } else if (settings.modelFormat === "openai_responses") {
    endpoint = modelEndpoint(settings.modelBaseUrl, "/responses", settings.modelFormat);
    payload = { model: settings.modelName.trim(), instructions: PROMPT, input: [{ role: "user", content: [{ type: "input_text", text: context }, { type: "input_image", image_url: `data:${mime};base64,${base64}`, detail: "low" }] }] };
  } else if (settings.modelFormat === "google") {
    endpoint = modelEndpoint(settings.modelBaseUrl, `/models/${encodeURIComponent(settings.modelName.trim())}:generateContent`, settings.modelFormat);
    payload = { systemInstruction: { parts: [{ text: PROMPT }] }, contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: base64 } }, { text: context }] }] };
  } else {
    endpoint = modelEndpoint(settings.modelBaseUrl, "/chat/completions", settings.modelFormat);
    payload = { model: settings.modelName.trim(), temperature: 0, messages: [{ role: "system", content: PROMPT }, { role: "user", content: [{ type: "text", text: context }, { type: "image_url", image_url: { url: `data:${mime};base64,${base64}`, detail: "low" } }] }] };
  }
  const headers: Record<string, string> = settings.modelFormat === "anthropic"
    ? { "x-api-key": settings.modelKey.trim(), "anthropic-version": "2023-06-01" }
    : settings.modelFormat === "google" ? { "x-goog-api-key": settings.modelKey.trim() } : { Authorization: `Bearer ${settings.modelKey.trim()}` };
  const response = await proxyRequest(endpoint, "POST", headers, payload);
  const text = responseText(response.body, settings.modelFormat).trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  const parsed = JSON.parse(text) as { classification?: string; description?: string };
  if (parsed.classification !== "RELEVANT" && parsed.classification !== "PROMOTION") throw new Error("模型未给出明确的图片判断");
  return { classification: parsed.classification, description: typeof parsed.description === "string" ? parsed.description.slice(0, 200) : "" };
}

/** Suggest removals after text review; keep full Markdown until the user decides. */
export async function reviewImages(article: Article, summary: string, settings: Settings): Promise<ImageReviewResult> {
  const images = refs(article.markdown, article.url);
  const warnings: string[] = [];
  const decisions: ImageDecision[] = [];
  let reviewed = 0;
  if (images.length > MAX_IMAGES) warnings.push(`仅识别前 ${MAX_IMAGES} 张图片，其余保留`);
  for (const [index, ref] of images.entries()) {
    if (decisions.some(item => item.full === ref.full)) continue;
    if (index >= MAX_IMAGES) {
      decisions.push({ full: ref.full, alt: ref.alt, url: ref.url, description: "未审阅，默认保留", recommendedRemove: false, remove: false });
      continue;
    }
    try {
      const result = await classify(ref, article, summary, settings);
      reviewed++;
      const recommendedRemove = result.classification === "PROMOTION";
      decisions.push({ full: ref.full, alt: ref.alt, url: ref.url, description: result.description || ref.alt || "文章相关图片", recommendedRemove, remove: recommendedRemove });
    } catch (error) {
      decisions.push({ full: ref.full, alt: ref.alt, url: ref.url, description: "未能识别，默认保留", recommendedRemove: false, remove: false });
      warnings.push(`${ref.alt || ref.raw}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { decisions, reviewed, warnings };
}

/** Restore images a text model omitted, anchored after the nearest surviving source line. */
export function restoreImages(markdown: string, source: Article, kept: ImageRef[] = refs(source.markdown, source.url)): string {
  let result = markdown;
  const sourceLines = source.markdown.split("\n");
  for (const image of kept) {
    if (result.includes(image.full) || (image.url && result.includes(`](${image.url})`))) continue;
    const index = sourceLines.findIndex(line => line.includes(image.full));
    const anchor = sourceLines.slice(0, index).reverse().find(line => line.trim() && !line.includes("!["))?.trim();
    const position = anchor ? result.indexOf(anchor) : -1;
    if (position >= 0) result = `${result.slice(0, position + anchor!.length)}\n\n${image.full}${result.slice(position + anchor!.length)}`;
    else result = `${result.trimEnd()}\n\n${image.full}\n`;
  }
  return result;
}

/** Apply only the user's current image choices to the reviewed draft. */
export function applyImageDecisions(markdown: string, decisions: ImageDecision[]): string {
  const removed = new Set(decisions.filter(item => item.remove).map(item => item.full));
  return markdown.replace(IMAGE, full => removed.has(full) ? "" : full).replace(/\n{3,}/g, "\n\n");
}

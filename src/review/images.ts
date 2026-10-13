/** Conservative image review adapted from Noosphere's image_filter workflow. */
import { proxyRequest, throwIfCancelled } from "../siyuan/api";
import type { Article, Settings } from "../types";
import { modelEndpoint } from "./endpoint";
import { isArticleImagePlaceholder, localAssetPath, resolveImageReference } from "../images/reference";
import { conciseRequestError } from "../siyuan/errors";

const IMAGE = /!\[([^\]]*)\]\((<?[^\s)]+>?)(?:\s+"[^"]*")?\)/g;
const IMAGE_CONCURRENCY = 2;
const IMAGE_REVIEW_TIMEOUT_MS = 120000;
const PROMPT = `你正在审阅文章图片。只返回 JSON：{"classification":"RELEVANT"或"PROMOTION","description":"一句简短客观的图片描述"}。
保留代码和界面截图、技术图、图表、与正文相关的照片或插画。仅在确定图片是二维码、关注订阅图、广告横幅或无关占位装饰时标记 PROMOTION。混合内容、证据不足或无法确定时标记 RELEVANT。不要凭图片修改文章事实。`;

interface ImageRef { full: string; raw: string; alt: string; url: string }
export interface ImageDecision { full: string; alt: string; url: string; description: string; recommendedRemove: boolean; remove: boolean; status?: "pending" | "reviewed" | "failed"; error?: string; previewUrl?: string }
export interface ImageReviewResult { decisions: ImageDecision[]; reviewed: number; warnings: string[] }

/** 兼容旧草稿的文字状态，正确显示素材的审阅结果。 */
export function imageDecisionStatus(decision: ImageDecision): "pending" | "reviewed" | "failed" {
  return decision.status || (decision.description === "未审阅，默认保留" ? "pending" : decision.description === "未能识别，默认保留" ? "failed" : "reviewed");
}

/** 素材面板在未调用 AI 时也展示图片，源码始终留在内部草稿中。 */
export function imageInventory(markdown: string, articleUrl: string): ImageDecision[] {
  return [...new Map(refs(markdown, articleUrl).map(ref => [ref.full, ref])).values()].map(ref => ({
    full: ref.full, alt: ref.alt, url: ref.url, description: "未审阅，默认保留", recommendedRemove: false, remove: false, status: "pending",
  }));
}

/** 按 Markdown 引用修正旧草稿的地址，保留已有判断与用户取舍。 */
export function normalizeImageDecisions(decisions: ImageDecision[], articleUrl: string): ImageDecision[] {
  return decisions.filter(item => !isArticleImagePlaceholder(item.url, articleUrl)).map(item => {
    const ref = refs(item.full, articleUrl)[0];
    const normalized = ref ? { ...item, url: ref.url } : { ...item };
    if (normalized.error) normalized.error = conciseRequestError(normalized.error);
    return normalized;
  });
}

/** 本地化后的缩略图读取思源资源，原始 URL 继续用于图片来源。 */
export function localizeImagePreviews(decisions: ImageDecision[], assets: Record<string, string>, articleUrl: string): ImageDecision[] {
  return decisions.map(item => {
    const ref = refs(item.full, articleUrl)[0];
    const local = ref && (assets[ref.raw] || assets[ref.url]);
    return local ? { ...item, previewUrl: localAssetPath(local) || local } : item;
  });
}

/** 完整审阅流程使用单独配置的图片模型。 */
export function imageReviewSettings(settings: Settings): Settings {
  const profile = settings.imageProvider ? settings.modelProfiles[settings.imageProvider] : undefined;
  const result = profile ? { ...settings, ...profile, activeProvider: settings.imageProvider as Settings["activeProvider"] } : settings;
  if (!result.modelVisionCapable || !result.modelKey.trim() || !result.modelName.trim() || !result.modelBaseUrl.trim()) throw new Error("图片审阅模型尚未配置完成，请选择已标记支持识图的供应商");
  return result;
}

function refs(markdown: string, articleUrl: string): ImageRef[] {
  return [...markdown.matchAll(IMAGE)].filter(match => !isArticleImagePlaceholder(match[2], articleUrl)).map(match => {
    const raw = match[2].replace(/^<|>$/g, "");
    const url = resolveImageReference(raw, articleUrl);
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

async function classify(ref: ImageRef, article: Article, summary: string, settings: Settings, signal?: AbortSignal): Promise<{ classification: "RELEVANT" | "PROMOTION"; description: string }> {
  throwIfCancelled(signal);
  // 本地资源直接由当前思源读取，不能经外部网站或代理重新下载。
  const local = localAssetPath(ref.raw);
  let downloaded: { body: string; contentType: string };
  if (local) {
    const response = await fetch(local, { signal });
    if (!response.ok) throw new Error(`思源图片读取失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    downloaded = { body: btoa(binary), contentType: response.headers.get("Content-Type") || "" };
  } else {
    const imageUrl = new URL(ref.url);
    if (!["http:", "https:"].includes(imageUrl.protocol)) throw new Error("图片地址不是 HTTP 链接");
    try { downloaded = await proxyRequest(imageUrl.href, "GET", {}, undefined, "base64", 60000, signal); }
    catch (error) { throwIfCancelled(signal); throw new Error(`图片下载失败：${conciseRequestError(error instanceof Error ? error.message : String(error))}`); }
  }
  throwIfCancelled(signal);
  const mime = downloaded.contentType.split(";")[0].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)) throw new Error(`模型暂不支持 ${mime || "未知"} 图片格式`);
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
  let response: Awaited<ReturnType<typeof proxyRequest>>;
  try { response = await proxyRequest(endpoint, "POST", headers, payload, "text", IMAGE_REVIEW_TIMEOUT_MS, signal); }
  catch (error) { throwIfCancelled(signal); throw new Error(`图片模型请求失败：${conciseRequestError(error instanceof Error ? error.message : String(error))}`); }
  throwIfCancelled(signal);
  const text = responseText(response.body, settings.modelFormat).trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  const parsed = JSON.parse(text) as { classification?: string; description?: string };
  if (parsed.classification !== "RELEVANT" && parsed.classification !== "PROMOTION") throw new Error("模型未给出明确的图片判断");
  return { classification: parsed.classification, description: typeof parsed.description === "string" ? parsed.description.slice(0, 200) : "" };
}

/** Suggest removals after text review; keep full Markdown until the user decides. */
export async function reviewImages(article: Article, summary: string, settings: Settings, onProgress?: (result: ImageReviewResult) => void, signal?: AbortSignal): Promise<ImageReviewResult> {
  throwIfCancelled(signal);
  const images = [...new Map(refs(article.markdown, article.url).map(ref => [ref.full, ref])).values()];
  const decisions = imageInventory(article.markdown, article.url);
  // 同一次审阅覆盖全部图片；相同地址的多个引用共享本次识别结果。
  const byUrl = new Map<string, Array<{ ref: ImageRef; index: number }>>();
  images.forEach((ref, index) => {
    const group = byUrl.get(ref.url) || [];
    group.push({ ref, index });
    byUrl.set(ref.url, group);
  });
  const groups = Array.from(byUrl.values());
  const warnings: string[] = [];
  const snapshot = (): ImageReviewResult => ({ decisions: decisions.map(item => ({ ...item })), reviewed: decisions.filter(item => imageDecisionStatus(item) === "reviewed").length, warnings: [...warnings] });
  let next = 0;
  onProgress?.(snapshot());
  const worker = async (): Promise<void> => {
    while (next < groups.length) {
      throwIfCancelled(signal);
      const group = groups[next++];
      try {
        const result = await classify(group[0].ref, article, summary, settings, signal);
        throwIfCancelled(signal);
        for (const { ref, index } of group) {
          const recommendedRemove = result.classification === "PROMOTION";
          decisions[index] = { ...decisions[index], description: result.description || ref.alt || "文章相关图片", recommendedRemove, remove: recommendedRemove, status: "reviewed" };
        }
      } catch (error) {
        throwIfCancelled(signal);
        const message = error instanceof Error ? error.message : String(error);
        for (const { index } of group) decisions[index] = { ...decisions[index], description: "未能识别，默认保留", status: "failed", error: message };
        warnings.push(`图片 ${group[0].index + 1}：${message}`);
      }
      // 处理过程中持续保留结果，完成状态在全部图片处理后统一返回。
      onProgress?.(snapshot());
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, groups.length) }, worker));
  return snapshot();
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

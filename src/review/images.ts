/** Conservative image review adapted from Noosphere's image_filter workflow. */
import { NetworkDisconnectedError, ProxyTimeoutError, proxyRequest, requestWithTimeout, throwIfCancelled } from "../siyuan/api";
import type { Article, Settings } from "../types";
import { modelEndpoint } from "./endpoint";
import { imageIdentity, isArticleImagePlaceholder, localAssetPath, resolveImageReference } from "../images/reference";
import { conciseRequestError, ServiceResponseError, throwIfServiceError, UpstreamHttpError } from "../siyuan/errors";
import { chatResponseContent, reasoningRequestOptions } from "./reasoning";
import { downloadRemoteImage, ImageUnavailableError, unavailableImageError } from "../images/download";

const IMAGE_CONCURRENCY = 2;
import { IMAGE_REVIEW_TIMEOUT_MS, IMAGE_DOWNLOAD_TIMEOUT_MS } from "../siyuan/timeouts";
const PROMPT = `你正在审阅文章图片。只返回 JSON：{"classification":"RELEVANT"或"PROMOTION","description":"一句简短客观的图片描述"}。
保留代码和界面截图、技术图、图表、与正文相关的照片或插画。仅在确定图片是二维码、关注订阅图、广告横幅或无关占位装饰时标记 PROMOTION。混合内容、证据不足或无法确定时标记 RELEVANT。不要凭图片修改文章事实。`;

/** 模型端不可用时结束整批，不能对余下每张图片重复请求同一个故障服务。 */
class ImageModelUnavailableError extends Error {
  constructor(error: unknown) { super(`图片模型请求失败：${conciseRequestError(error instanceof Error ? error.message : String(error))}`); }
}

interface ImageRef { full: string; raw: string; alt: string; url: string }
export interface ImageDecision { full: string; alt: string; url: string; description: string; recommendedRemove: boolean; remove: boolean; status?: "pending" | "reviewed" | "failed"; error?: string; errorStage?: "download"; previewUrl?: string; unplaced?: boolean; manuallyAdded?: boolean }
export interface ImageReviewResult { decisions: ImageDecision[]; reviewed: number; warnings: string[] }

/** 兼容旧草稿的文字状态，正确显示素材的审阅结果。 */
export function imageDecisionStatus(decision: ImageDecision): "pending" | "reviewed" | "failed" {
  return decision.status || (decision.description === "未审阅，默认保留" ? "pending" : decision.description === "未能识别，默认保留" ? "failed" : "reviewed");
}

/** 坏图沿用失败状态，记录来源错误位置；兼容旧记录中的明确下载/格式错误。 */
export function imageSourceUnavailable(decision: ImageDecision): boolean {
  if (imageDecisionStatus(decision) !== "failed") return false;
  if (decision.errorStage === "download" || /^(?:模型暂不支持 .+ 图片格式|图片地址无效，无法下载)/.test(decision.error || "")) return true;
  const oldDownloadCode = decision.error?.match(/^图片下载失败：.*HTTP (\d+)/)?.[1];
  return !!oldDownloadCode && Number(oldDownloadCode) >= 400 && Number(oldDownloadCode) < 500 && ![408, 429].includes(Number(oldDownloadCode));
}

/** 图片来源已确认不可用时默认保留，不再阻止阶段完成；模型结果仍按原规则重试。 */
export function imageNeedsReview(decision: ImageDecision): boolean {
  const status = imageDecisionStatus(decision);
  return !decision.remove && !decision.unplaced && status !== "reviewed" && !imageSourceUnavailable(decision);
}

/** 素材优先展示用户已经完成的添加/移除操作，独立保留模型识别结果。 */
export function imageDisplayStatus(decision: ImageDecision): ReturnType<typeof imageDecisionStatus> | "added" | "removed" | "unplaced" {
  return decision.remove ? "removed" : decision.unplaced ? "unplaced" : decision.manuallyAdded ? "added" : imageDecisionStatus(decision);
}

/** 素材面板在未调用 AI 时也展示图片，源码始终留在内部草稿中。 */
export function imageInventory(markdown: string, articleUrl: string): ImageDecision[] {
  return [...new Map(refs(markdown, articleUrl).map(ref => [ref.full, ref])).values()].map(ref => ({
    full: ref.full, alt: ref.alt, url: ref.url, description: "未审阅，默认保留", recommendedRemove: false, remove: false, status: "pending",
  }));
}

/** 引用修复失败时把未出现在文字稿的原图保留在素材中，不推测正文位置或额外调用识图。 */
export function preserveSourceImages(decisions: ImageDecision[], source: Article): ImageDecision[] {
  const present = new Set(decisions.map(item => imageIdentity(item.url)));
  const missing = imageInventory(source.markdown, source.url).filter(item => {
    const identity = imageIdentity(item.url);
    if (present.has(identity)) return false;
    present.add(identity); return true;
  }).map(item => ({ ...item, unplaced: true, description: "原图已保留，正文位置待确认。" }));
  return [...decisions, ...missing];
}

/** 正文与素材双向同步；原生删除标记移除，撤销恢复状态，尚未定位的原图继续保留。 */
export function syncEditedImages(markdown: string, articleUrl: string, previous: ImageDecision[]): ImageDecision[] {
  const matches = (old: ImageDecision, current: ImageDecision): boolean => [old.url, old.previewUrl]
    .some(url => !!url && imageIdentity(resolveImageReference(url, articleUrl)) === imageIdentity(current.url));
  const present = imageInventory(markdown, articleUrl);
  // 素材保持原来的排列，正文插入/移除后不会使卡片跳动或打乱多选顺序。
  const decisions = previous.map(old => {
    const current = present.find(item => matches(old, item));
    if (current) return { ...old, full: current.full, alt: current.alt, remove: false, unplaced: false, manuallyAdded: old.manuallyAdded || old.remove || old.unplaced };
    return old.remove || old.unplaced ? old : { ...old, remove: true };
  });
  return [...decisions, ...present.filter(item => !previous.some(old => matches(old, item))).map(item => ({ ...item, manuallyAdded: true }))];
}

/** 按 Markdown 引用修正旧草稿的地址，保留已有判断与用户取舍。 */
export function normalizeImageDecisions(decisions: ImageDecision[], articleUrl: string): ImageDecision[] {
  const normalized = decisions.filter(item => !isArticleImagePlaceholder(item.url, articleUrl)).map(item => {
    const ref = refs(item.full, articleUrl)[0];
    const normalized = ref ? { ...item, url: ref.url } : { ...item };
    if (normalized.error) normalized.error = conciseRequestError(normalized.error);
    return normalized;
  });
  // 修复旧草稿对同一微信配图的矛盾建议；用户主动改变过的取舍继续保留。
  const promotions = new Map(normalized.filter(item => imageDecisionStatus(item) === "reviewed" && item.recommendedRemove)
    .map(item => [imageIdentity(item.url), item]));
  return normalized.map(item => {
    const shared = promotions.get(imageIdentity(item.url));
    if (!shared || item.recommendedRemove || item.remove !== item.recommendedRemove) return item;
    const { error: _error, ...rest } = item;
    return { ...rest, description: shared.description, recommendedRemove: true, remove: true, status: "reviewed" as const };
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

/** 只处理展示用配图，保留围栏、缩进代码和行内代码中的图片语法示例。 */
function mapImages(markdown: string, transform: (full: string, alt: string, raw: string) => string): string {
  let fence: string | undefined;
  return markdown.split(/(\r?\n)/).map((line: string): string => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return line;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) return line;
    return line.replace(/(`+).*?\1|!\[([^\]]*)\]\((<?[^\s)]+>?)(?:\s+"[^"]*")?\)/g,
      (full: string, code: string | undefined, alt: string, raw: string): string => code ? full : transform(full, alt, raw));
  }).join("");
}

function refs(markdown: string, articleUrl: string): ImageRef[] {
  const result: ImageRef[] = [];
  mapImages(markdown, (full: string, alt: string, value: string): string => {
    const raw = value.replace(/^<|>$/g, "");
    if (!isArticleImagePlaceholder(raw, articleUrl)) result.push({ full, raw, alt, url: resolveImageReference(raw, articleUrl) });
    return full;
  });
  return result;
}

function responseText(body: string, format: Settings["modelFormat"]): string {
  const data = JSON.parse(body) as any;
  throwIfServiceError(data);
  if (format === "anthropic") return data.content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n") || "";
  if (format === "openai_responses") return data.output_text || data.output?.flatMap((item: any) => item.content || []).filter((item: any) => item.type === "output_text").map((item: any) => item.text).join("\n") || "";
  if (format === "google") return data.candidates?.[0]?.content?.parts?.filter((item: any) => !item.thought).map((item: any) => item.text || "").join("\n") || "";
  const content = data.choices?.[0]?.message?.content;
  return chatResponseContent(content);
}

async function classify(ref: ImageRef, article: Article, summary: string, settings: Settings, signal?: AbortSignal): Promise<{ classification: "RELEVANT" | "PROMOTION"; description: string }> {
  throwIfCancelled(signal);
  // 本地资源直接由当前思源读取，不能经外部网站或代理重新下载。
  const local = localAssetPath(ref.raw);
  let downloaded: { body: string; contentType: string };
  if (local) {
    downloaded = await requestWithTimeout(async requestSignal => {
      const response = await fetch(local, { signal: requestSignal });
      if (!response.ok) {
        const error = new UpstreamHttpError(response.status, "");
        throw unavailableImageError(error) ? new ImageUnavailableError(error) : error;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      return { body: btoa(binary), contentType: response.headers.get("Content-Type") || "" };
    }, IMAGE_DOWNLOAD_TIMEOUT_MS, signal);
  } else {
    let imageUrl: URL;
    try { imageUrl = new URL(ref.url); if (!["http:", "https:"].includes(imageUrl.protocol)) throw new Error("图片地址不是 HTTP 链接"); }
    catch { throw new ImageUnavailableError("图片地址无效，无法下载"); }
    downloaded = await downloadRemoteImage(imageUrl.href, signal);
  }
  throwIfCancelled(signal);
  const mime = downloaded.contentType.split(";")[0].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)) throw new ImageUnavailableError(`模型暂不支持 ${mime || "未知"} 图片格式`);
  const context = `文章标题：${article.title}\n审阅后摘要：${summary}\n图片说明：${ref.alt || "无"}\n请结合审阅后的文章判断图片是否相关。`;
  const base64 = downloaded.body;
  let endpoint: string;
  let payload: object;
  if (settings.modelFormat === "anthropic") {
    endpoint = modelEndpoint(settings.modelBaseUrl, "/messages", settings.modelFormat);
    payload = { model: settings.modelName.trim(), max_tokens: 1024, system: PROMPT, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mime, data: base64 } }, { type: "text", text: context }] }] };
  } else if (settings.modelFormat === "openai_responses") {
    endpoint = modelEndpoint(settings.modelBaseUrl, "/responses", settings.modelFormat);
    payload = { model: settings.modelName.trim(), instructions: PROMPT, input: [{ role: "user", content: [{ type: "input_text", text: context }, { type: "input_image", image_url: `data:${mime};base64,${base64}`, detail: "low" }] }] };
  } else if (settings.modelFormat === "google") {
    endpoint = modelEndpoint(settings.modelBaseUrl, `/models/${encodeURIComponent(settings.modelName.trim())}:generateContent`, settings.modelFormat);
    payload = { systemInstruction: { parts: [{ text: PROMPT }] }, contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: base64 } }, { text: context }] }] };
  } else {
    endpoint = modelEndpoint(settings.modelBaseUrl, "/chat/completions", settings.modelFormat);
    payload = { model: settings.modelName.trim(), temperature: 0, ...reasoningRequestOptions(settings), messages: [{ role: "system", content: PROMPT }, { role: "user", content: [{ type: "text", text: context }, { type: "image_url", image_url: { url: `data:${mime};base64,${base64}`, detail: "low" } }] }] };
  }
  const headers: Record<string, string> = settings.modelFormat === "anthropic"
    ? { "x-api-key": settings.modelKey.trim(), "anthropic-version": "2023-06-01" }
    : settings.modelFormat === "google" ? { "x-goog-api-key": settings.modelKey.trim() } : { Authorization: `Bearer ${settings.modelKey.trim()}` };
  // 下载只执行一次；模型的空白、截断或非 JSON 回答最多重试一次，取消立即生效。
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfCancelled(signal);
    let response: Awaited<ReturnType<typeof proxyRequest>>;
    try { response = await proxyRequest(endpoint, "POST", headers, payload, "text", IMAGE_REVIEW_TIMEOUT_MS, signal); }
    catch (error) { throwIfCancelled(signal); if (error instanceof ServiceResponseError) throw new ServiceResponseError(error.code, `图片模型请求失败：${conciseRequestError(error.message)}`); throw new ImageModelUnavailableError(error); }
    throwIfCancelled(signal);
    try {
      const text = responseText(response.body, settings.modelFormat).trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
      const parsed = JSON.parse(text) as { classification?: string; description?: string };
      throwIfServiceError(parsed);
      if (parsed?.classification !== "RELEVANT" && parsed?.classification !== "PROMOTION") throw new Error("缺少图片判断");
      return { classification: parsed.classification, description: typeof parsed.description === "string" ? parsed.description.slice(0, 200) : "" };
    } catch (error) {
      if (error instanceof ServiceResponseError) throw error;
      if (attempt === 1) throw new Error("图片模型返回不完整或无效的识别结果，重试后仍未完成");
    }
  }
  throw new Error("图片识别未完成");
}

/** Suggest removals after text review; keep full Markdown until the user decides. */
export async function reviewImages(article: Article, summary: string, settings: Settings, onProgress?: (result: ImageReviewResult) => void, signal?: AbortSignal, previous: ImageDecision[] = []): Promise<ImageReviewResult> {
  throwIfCancelled(signal);
  const images = [...new Map(refs(article.markdown, article.url).map(ref => [ref.full, ref])).values()];
  const decisions = imageInventory(article.markdown, article.url).map(current => {
    const old = previous.find(item => item.full === current.full)
      || previous.find(item => imageIdentity(item.url) === imageIdentity(current.url) && (imageDecisionStatus(item) === "reviewed" || imageSourceUnavailable(item)));
    if (!old) return current;
    return { ...old, ...current, description: old.description, recommendedRemove: old.recommendedRemove, remove: old.remove,
      status: imageDecisionStatus(old) === "reviewed" || imageSourceUnavailable(old) ? imageDecisionStatus(old) : "pending" as const,
      error: imageSourceUnavailable(old) ? old.error : undefined, errorStage: imageSourceUnavailable(old) ? "download" as const : undefined };
  });
  // 同一次审阅覆盖全部图片；相同地址的多个引用共享本次识别结果。
  const byUrl = new Map<string, Array<{ ref: ImageRef; index: number }>>();
  images.forEach((ref, index) => {
    const identity = imageIdentity(ref.url);
    const group = byUrl.get(identity) || [];
    group.push({ ref, index });
    byUrl.set(identity, group);
  });
  const groups = Array.from(byUrl.values()).filter(group => {
    const completed = group.map(({ index }) => decisions[index]).find(item => imageDecisionStatus(item) === "reviewed" || imageSourceUnavailable(item));
    if (!completed) return group.some(({ index }) => imageNeedsReview(decisions[index]));
    // 同一图片的多个引用共用已完成判断，但保留每个引用的人工取舍和说明。
    for (const { index } of group) {
      if (imageDecisionStatus(decisions[index]) === "reviewed" || imageSourceUnavailable(decisions[index])) continue;
      decisions[index] = { ...decisions[index], description: completed.description, recommendedRemove: completed.recommendedRemove,
        remove: previous.some(item => item.full === decisions[index].full) ? decisions[index].remove : completed.remove,
        status: imageDecisionStatus(completed), error: completed.error, errorStage: completed.errorStage };
    }
    return false;
  });
  const warnings: string[] = [];
  const snapshot = (): ImageReviewResult => ({ decisions: decisions.map(item => ({ ...item })), reviewed: decisions.filter(item => imageDecisionStatus(item) === "reviewed").length, warnings: [...warnings] });
  let next = 0;
  let stopped = false;
  const parentSignal = signal, controller = new AbortController();
  const abort = (): void => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) abort();
  signal = controller.signal;
  const worker = async (): Promise<void> => {
    while (!stopped && next < groups.length) {
      throwIfCancelled(signal);
      const group = groups[next++];
      try {
        const result = await classify(group[0].ref, article, summary, settings, signal);
        if (stopped) return;
        throwIfCancelled(signal);
        for (const { ref, index } of group) {
          const recommendedRemove = result.classification === "PROMOTION";
          decisions[index] = { ...decisions[index], description: result.description || ref.alt || "文章相关图片", recommendedRemove, remove: recommendedRemove, status: "reviewed" };
        }
      } catch (error) {
        if (stopped) return;
        throwIfCancelled(signal);
        if (error instanceof ImageModelUnavailableError || error instanceof NetworkDisconnectedError || error instanceof ProxyTimeoutError || error instanceof TypeError || error instanceof ServiceResponseError) { stopped = true; controller.abort(error); throw error; }
        const message = error instanceof Error ? error.message : String(error);
        const sourceUnavailable = error instanceof ImageUnavailableError;
        for (const { index } of group) decisions[index] = { ...decisions[index], description: "未能识别，默认保留", status: "failed", error: message,
          errorStage: sourceUnavailable ? "download" : undefined };
        warnings.push(`图片 ${group[0].index + 1}：${message}`);
      }
      // 处理过程中持续保留结果，完成状态在全部图片处理后统一返回。
      onProgress?.(snapshot());
    }
  };
  try {
    onProgress?.(snapshot());
    await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, groups.length) }, worker));
    return snapshot();
  } finally { parentSignal?.removeEventListener("abort", abort); controller.abort(); }
}

/** 链接已在请求边界锁定；此处只按原文位置补回文字模型遗漏的配图。 */
export function restoreImages(markdown: string, source: Article, kept: ImageRef[] = refs(source.markdown, source.url)): string {
  let result = markdown;
  const present = new Set(refs(result, source.url).map(image => image.url));
  const sourceLines = source.markdown.split("\n");
  for (const image of kept) {
    if (present.has(image.url)) continue;
    const index = sourceLines.findIndex(line => line.includes(image.full));
    const anchor = sourceLines.slice(0, index).reverse().find(line => line.trim() && !line.includes("!["))?.trim();
    const position = anchor ? result.indexOf(anchor) : -1;
    if (position >= 0) result = `${result.slice(0, position + anchor!.length)}\n\n${image.full}${result.slice(position + anchor!.length)}`;
    else result = `${result.trimEnd()}\n\n${image.full}\n`;
    present.add(image.url);
  }
  return result;
}

/** Apply only the user's current image choices to the reviewed draft. */
export function applyImageDecisions(markdown: string, decisions: ImageDecision[]): string {
  const removed = new Set(decisions.filter(item => item.remove).map(item => item.full));
  return mapImages(markdown, (full: string): string => removed.has(full) ? "" : full).replace(/\n{3,}/g, "\n\n");
}

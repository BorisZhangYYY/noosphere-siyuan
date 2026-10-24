/** Review adapters and model discovery for the supported HTTP API protocols. */
import { proxyRequest, proxyStreamRequest, StreamProxyUnavailableError, ProxyTimeoutError, throwIfCancelled, type ProxyResponse } from "../siyuan/api";
import type { Article, Settings } from "../types";
import { buildReviewPrompt, parseReviewResult } from "./perspectives";
import { imageInventory, imageReviewSettings, preserveSourceImages, restoreImages, reviewImages, type ImageDecision, type ImageReviewResult } from "./images";
import { modelEndpoint } from "./endpoint";
import { headers } from "./provider-headers";
import { ModelReviewStream } from "./stream";
import { lockReviewLinks } from "./links";
import { repairReviewLinks } from "./link-repair";
export { modelEndpoint } from "./endpoint";

const REVIEW_TIMEOUT_MS = 60 * 60 * 1000;

export interface ArticleReviewResult { markdown: string; article: Article; summary: string; metadataAccepted: string[]; imageDecisions: ImageDecision[]; imagesReviewed: number; imageWarnings: string[]; linkRepair?: { attempts: number; unresolved: number } }
export interface ArticleReviewOptions {
  onTextReviewed?: (result: ArticleReviewResult) => void;
  onImageProgress?: (result: ImageReviewResult) => void;
  onTextDelta?: (response: string) => void;
  onStreamActivity?: () => void;
  onStreamFallback?: () => void;
  onLinkRepair?: (attempt: number) => void;
  signal?: AbortSignal;
}

interface ApiError { error?: { message?: string } | string; message?: string }
interface ChatCompletion extends ApiError {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | Array<{ type: string; text?: string }> } }>;
}
interface AnthropicMessage extends ApiError { stop_reason?: string; content?: Array<{ type: string; text?: string }> }
interface OpenAIResponse extends ApiError { status?: string; incomplete_details?: { reason?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
interface GeminiResponse extends ApiError { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }> }

/** Kimi Code 长文需保留完整正文；按字符数增加输出预算，避免沿用短回复的 4096 上限。 */
function reviewOutputTokens(markdown: string, settings: Settings): number {
  const kimiCode = settings.activeProvider === "kimi_code" || /^kimi-for-coding(?:-|$)/i.test(settings.modelName);
  return kimiCode ? Math.min(32768, Math.max(8192, Math.ceil(markdown.length * 1.5) + 2048)) : 4096;
}

function errorText(result: ApiError): string {
  return typeof result.error === "string" ? result.error : result.error?.message || result.message || "模型未返回审阅内容";
}

/** List models exposed by the configured provider, while retaining manual entry for proxy services. */
export async function listAvailableModels(settings: Settings): Promise<string[]> {
  if (!settings.modelKey.trim()) throw new Error("请先填写模型 API Key");
  if (!settings.modelBaseUrl.trim()) throw new Error("请先填写模型 API 地址");
  const names: string[] = [];
  const url = new URL(modelEndpoint(settings.modelBaseUrl, "/models", settings.modelFormat));
  if (settings.modelFormat === "google") url.searchParams.set("pageSize", "1000");
  if (settings.modelFormat === "anthropic") url.searchParams.set("limit", "1000");
  // Google and Anthropic paginate model lists; cap the loop to avoid a misbehaving proxy.
  for (let page = 0; page < 5; page++) {
    const response = await proxyRequest(url.href, "GET", headers(settings));
    const result = JSON.parse(response.body) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string; supportedGenerationMethods?: string[]; supportedActions?: string[] }>; nextPageToken?: string; has_more?: boolean; last_id?: string } & ApiError;
    const current = settings.modelFormat === "google"
      ? result.models?.filter(model => {
        const methods = model.supportedGenerationMethods || model.supportedActions;
        return !methods || methods.includes("generateContent");
      }).map(model => model.name?.replace(/^models\//, ""))
      : result.data?.map(model => model.id);
    names.push(...(current || []).filter((name): name is string => Boolean(name)));
    if (settings.modelFormat === "google" && result.nextPageToken) url.searchParams.set("pageToken", result.nextPageToken);
    else if (settings.modelFormat === "anthropic" && result.has_more && result.last_id) url.searchParams.set("after_id", result.last_id);
    else {
      if (!names.length) throw new Error(errorText(result) === "模型未返回审阅内容" ? "服务未返回可用模型；可手动输入模型 ID" : errorText(result));
      break;
    }
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** Keep the editable draft separate from the crawler's original article. */
export async function reviewArticleDetailed(article: Article, settings: Settings, draftMarkdown: string = article.markdown, options: ArticleReviewOptions = {}): Promise<ArticleReviewResult> {
  throwIfCancelled(options.signal);
  if (settings.reviewPerspective === "raw") return { markdown: article.markdown, article, summary: "", metadataAccepted: [], imageDecisions: [], imagesReviewed: 0, imageWarnings: [] };
  const imageSettings = settings.imageReview ? imageReviewSettings(settings) : settings;
  if (!settings.modelKey.trim() || !settings.modelName.trim()) throw new Error("请配置模型 API Key 和模型名称");
  const links = lockReviewLinks(`来源：${article.url}\n标题：${article.title}\n抓取到的作者：${article.author || "缺失"}\n抓取到的发布时间：${article.publishedAt || "缺失"}\n\n${draftMarkdown}`);
  const userContent = links.input;
  const apiHeaders = headers(settings);
  let endpoint: string;
  let payload: object;
  if (settings.modelFormat === "anthropic") {
    endpoint = modelEndpoint(settings.modelBaseUrl, "/messages", settings.modelFormat);
    payload = { model: settings.modelName.trim(), max_tokens: reviewOutputTokens(draftMarkdown, settings), system: buildReviewPrompt(settings), messages: [{ role: "user", content: userContent }] };
  } else if (settings.modelFormat === "openai_responses") {
    endpoint = modelEndpoint(settings.modelBaseUrl, "/responses", settings.modelFormat);
    payload = { model: settings.modelName.trim(), instructions: buildReviewPrompt(settings), input: userContent };
  } else if (settings.modelFormat === "google") {
    endpoint = modelEndpoint(settings.modelBaseUrl, `/models/${encodeURIComponent(settings.modelName.trim())}:generateContent`, settings.modelFormat);
    payload = { systemInstruction: { parts: [{ text: buildReviewPrompt(settings) }] }, contents: [{ role: "user", parts: [{ text: userContent }] }] };
  } else {
    endpoint = modelEndpoint(settings.modelBaseUrl, "/chat/completions", settings.modelFormat);
    payload = { model: settings.modelName.trim(), temperature: 0.2, messages: [{ role: "system", content: buildReviewPrompt(settings) }, { role: "user", content: userContent }] };
  }
  let response: ProxyResponse | undefined;
  let streamedText: string | null = null;
  try {
    if (options.onTextDelta) {
      const stream = new ModelReviewStream(settings.modelFormat, (text: string): void => {
        const preview = links.preview(text);
        if (preview !== undefined) options.onTextDelta?.(preview);
      });
      const streamEndpoint = settings.modelFormat === "google" ? `${endpoint.replace(/:generateContent$/, ":streamGenerateContent")}?alt=sse` : endpoint;
      const streamPayload = settings.modelFormat === "google" ? payload : { ...payload, stream: true };
      try {
        const body = await proxyStreamRequest(streamEndpoint, apiHeaders, streamPayload, chunk => { options.onStreamActivity?.(); stream.parser.push(chunk); }, REVIEW_TIMEOUT_MS, options.signal);
        streamedText = stream.finish();
        if (streamedText === null) response = { body, status: 200, contentType: "application/json" };
      } catch (error) {
        if (!(error instanceof StreamProxyUnavailableError)) throw error;
        options.onStreamFallback?.();
        response = await proxyRequest(endpoint, "POST", apiHeaders, payload, "text", REVIEW_TIMEOUT_MS, options.signal);
      }
    } else response = await proxyRequest(endpoint, "POST", apiHeaders, payload, "text", REVIEW_TIMEOUT_MS, options.signal);
  }
  catch (error) {
    if (error instanceof ProxyTimeoutError) throw new Error(`${settings.modelName} 审阅请求超时，未收到完整结果。等待上限为 60 分钟，供应商或中间代理也可能提前超时；原稿已保留。`);
    throw error;
  }
  let responseText: string | undefined = streamedText || undefined;
  throwIfCancelled(options.signal);
  if (response) {
    let result: ChatCompletion & AnthropicMessage & OpenAIResponse & GeminiResponse;
    try { result = JSON.parse(response.body) as typeof result; }
    catch { throw new Error("模型接口返回了无法解析的响应，尚不能确认是否截断；原稿已保留，请重试或检查模型服务。"); }
    if (!result || typeof result !== "object") throw new Error("模型接口没有返回有效的审阅响应；原稿已保留。");
    // 先检查服务明确给出的停止原因，不能把截断正文当作完整审阅结果。
    const stopReason = settings.modelFormat === "anthropic" ? result.stop_reason
      : settings.modelFormat === "google" ? result.candidates?.[0]?.finishReason
      : settings.modelFormat === "openai_chat" ? result.choices?.[0]?.finish_reason
      : result.incomplete_details?.reason;
    if (["max_tokens", "length", "MAX_TOKENS", "max_output_tokens", "model_context_window_exceeded"].includes(stopReason || "")) {
      throw new Error("模型输出达到长度上限，审阅结果被截断；原稿已保留。请减少单次审阅内容，或选择支持更长输出的模型。");
    }
    if (settings.modelFormat === "openai_responses" && ["incomplete", "failed", "cancelled"].includes(result.status || "")) {
      throw new Error(`模型没有完成审阅（${result.incomplete_details?.reason || result.status}）；原稿已保留。`);
    }
    if (settings.modelFormat === "anthropic") responseText = result.content?.filter(part => part.type === "text").map(part => part.text || "").join("\n");
    else if (settings.modelFormat === "openai_responses") responseText = result.output_text || result.output?.flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text || "").join("\n");
    else if (settings.modelFormat === "google") responseText = result.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n");
    else {
      const content = result.choices?.[0]?.message?.content;
      responseText = typeof content === "string" ? content : content?.filter(part => part.type === "text").map(part => part.text || "").join("\n");
    }
    if (!responseText?.trim()) throw new Error(errorText(result));
  }
  if (!responseText?.trim()) throw new Error("模型未返回审阅内容");
  const repaired = await repairReviewLinks(responseText, links, settings, options.signal, options.onLinkRepair);
  const linkRepair = { attempts: repaired.attempts, unresolved: repaired.unresolved };
  const reviewed = parseReviewResult(repaired.response, article, settings);
  const source = { ...article, markdown: draftMarkdown };
  const markdown = repaired.unresolved ? reviewed.markdown : restoreImages(reviewed.markdown, source);
  const preserve = (decisions: ImageDecision[]): ImageDecision[] => repaired.unresolved ? preserveSourceImages(decisions, source) : decisions;
  options.onTextReviewed?.({ markdown, article: reviewed.article, summary: reviewed.summary, metadataAccepted: reviewed.metadataAccepted, imageDecisions: preserve(imageInventory(markdown, article.url)), imagesReviewed: 0, imageWarnings: [], linkRepair });
  throwIfCancelled(options.signal);
  const imageResult = settings.imageReview
    ? await reviewImages({ ...reviewed.article, markdown }, reviewed.summary, imageSettings, progress => options.onImageProgress?.({ ...progress, decisions: preserve(progress.decisions) }), options.signal)
    : null;
  throwIfCancelled(options.signal);
  return {
    markdown,
    article: reviewed.article,
    summary: reviewed.summary,
    metadataAccepted: reviewed.metadataAccepted,
    imageDecisions: preserve(imageResult?.decisions || imageInventory(markdown, article.url)),
    imagesReviewed: imageResult?.reviewed || 0,
    imageWarnings: imageResult?.warnings || [],
    linkRepair,
  };
}

export async function reviewArticle(article: Article, settings: Settings): Promise<string> {
  return (await reviewArticleDetailed(article, settings)).markdown;
}

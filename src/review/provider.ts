/** Review adapters and model discovery for the supported HTTP API protocols. */
import { proxyRequest } from "../siyuan/api";
import type { Article, Settings } from "../types";
import { buildReviewPrompt, parseReviewResult } from "./perspectives";
import { restoreImages, reviewImages, type ImageDecision } from "./images";
import { modelEndpoint } from "./endpoint";
export { modelEndpoint } from "./endpoint";

const ANTHROPIC_VERSION = "2023-06-01";

interface ApiError { error?: { message?: string } | string; message?: string }
interface ChatCompletion extends ApiError {
  choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
}
interface AnthropicMessage extends ApiError { content?: Array<{ type: string; text?: string }> }
interface OpenAIResponse extends ApiError { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
interface GeminiResponse extends ApiError { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }

function errorText(result: ApiError): string {
  return typeof result.error === "string" ? result.error : result.error?.message || result.message || "模型未返回审阅内容";
}

function headers(settings: Settings): Record<string, string> {
  if (settings.modelFormat === "anthropic") return { "x-api-key": settings.modelKey.trim(), "anthropic-version": ANTHROPIC_VERSION };
  if (settings.modelFormat === "google") return { "x-goog-api-key": settings.modelKey.trim() };
  return { Authorization: `Bearer ${settings.modelKey.trim()}` };
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
export async function reviewArticleDetailed(article: Article, settings: Settings, draftMarkdown: string = article.markdown): Promise<{ markdown: string; article: Article; summary: string; metadataAccepted: string[]; imageDecisions: ImageDecision[]; imagesReviewed: number; imageWarnings: string[] }> {
  if (settings.reviewPerspective === "raw") return { markdown: article.markdown, article, summary: "", metadataAccepted: [], imageDecisions: [], imagesReviewed: 0, imageWarnings: [] };
  const imageProfile = settings.imageProvider ? settings.modelProfiles[settings.imageProvider] : undefined;
  const imageSettings = imageProfile ? { ...settings, ...imageProfile } : settings;
  if (settings.imageReview && (!imageSettings.modelVisionCapable || !imageSettings.modelKey.trim() || !imageSettings.modelName.trim() || !imageSettings.modelBaseUrl.trim())) throw new Error("图片审阅模型尚未配置完成，请选择已标记支持识图的供应商");
  if (!settings.modelKey.trim() || !settings.modelName.trim()) throw new Error("请配置模型 API Key 和模型名称");
  const userContent = `来源：${article.url}\n标题：${article.title}\n抓取到的作者：${article.author || "缺失"}\n抓取到的发布时间：${article.publishedAt || "缺失"}\n\n${draftMarkdown}`;
  const apiHeaders = headers(settings);
  let endpoint: string;
  let payload: object;
  if (settings.modelFormat === "anthropic") {
    endpoint = modelEndpoint(settings.modelBaseUrl, "/messages", settings.modelFormat);
    payload = { model: settings.modelName.trim(), max_tokens: 4096, system: buildReviewPrompt(settings), messages: [{ role: "user", content: userContent }] };
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
  const response = await proxyRequest(endpoint, "POST", apiHeaders, payload);
  const result = JSON.parse(response.body) as ChatCompletion & AnthropicMessage & OpenAIResponse & GeminiResponse;
  let responseText: string | undefined;
  if (settings.modelFormat === "anthropic") responseText = result.content?.filter(part => part.type === "text").map(part => part.text || "").join("\n");
  else if (settings.modelFormat === "openai_responses") responseText = result.output_text || result.output?.flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text || "").join("\n");
  else if (settings.modelFormat === "google") responseText = result.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n");
  else {
    const content = result.choices?.[0]?.message?.content;
    responseText = typeof content === "string" ? content : content?.filter(part => part.type === "text").map(part => part.text || "").join("\n");
  }
  if (!responseText?.trim()) throw new Error(errorText(result));
  const reviewed = parseReviewResult(responseText, article, settings);
  const markdown = restoreImages(reviewed.markdown, { ...article, markdown: draftMarkdown });
  const imageResult = settings.imageReview
    ? await reviewImages({ ...reviewed.article, markdown }, reviewed.summary, imageSettings)
    : null;
  return {
    markdown,
    article: reviewed.article,
    summary: reviewed.summary,
    metadataAccepted: reviewed.metadataAccepted,
    imageDecisions: imageResult?.decisions || [],
    imagesReviewed: imageResult?.reviewed || 0,
    imageWarnings: imageResult?.warnings || [],
  };
}

export async function reviewArticle(article: Article, settings: Settings): Promise<string> {
  return (await reviewArticleDetailed(article, settings)).markdown;
}

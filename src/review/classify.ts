/**
 * 分类：把审阅稿交给模型，在用户已有的分类文档里选一个落点。
 * 与 Noosphere 本体一致，模型只能选择、不能创建；置信度不足或候选为空时落到根文档。
 */
import { proxyRequest } from "../siyuan/api";
import { classificationCandidates, type CategoryNode } from "../siyuan/tree";
import { modelEndpoint } from "./endpoint";
import { headers } from "./provider-headers";
import type { Settings } from "../types";

/** 低于该置信度视为没有把握，交给调用方回落到根文档。 */
export const CLASSIFY_CONFIDENCE = 0.6;

export const CLASSIFY_PROMPT = `你把一篇已审阅的文章放入用户已有的分类文档中。

你只能从给定的分类列表里选择一个 ID，绝不能创建、重命名、翻译或建议任何分类。
优先选择完整路径明确匹配文章主题的最深分类。分类文档可以同时容纳子分类和文章。

如果没有明确匹配的已有分类，返回 null 的 collection_id，应用会把文章放在分类根下。
confidence 是 0 到 1 的数字，应综合完整分类路径、分类介绍与文章主题判断。

只返回如下 JSON，不要包含代码围栏：

{"collection_id": "已有分类 ID 或 null", "confidence": 0.84, "reason": "文章主题与该分类路径匹配的原因"}`;

export interface ClassificationResult {
  /** 命中的分类文档 ID；未命中时为 null,调用方应落到根文档。 */
  categoryId: string | null;
  confidence: number;
  reason: string;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("分类结果不是有效的 JSON 对象");
  const payload = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("分类结果必须是 JSON 对象");
  return payload as Record<string, unknown>;
}

function classifyOutputTokens(markdown: string): number {
  return Math.min(1024, Math.max(256, Math.ceil(markdown.length / 20)));
}

/** 按供应商协议组装请求体；分类只需要短输出，沿用审阅的协议适配避免重复实现。 */
function requestShape(settings: Settings, systemPrompt: string, userMessage: string): { endpoint: string; payload: object } {
  const maxTokens = classifyOutputTokens(userMessage);
  if (settings.modelFormat === "anthropic") {
    return {
      endpoint: modelEndpoint(settings.modelBaseUrl, "/messages", settings.modelFormat),
      payload: { model: settings.modelName.trim(), max_tokens: maxTokens, temperature: 0.1, system: systemPrompt, messages: [{ role: "user", content: userMessage }] },
    };
  }
  if (settings.modelFormat === "openai_responses") {
    return {
      endpoint: modelEndpoint(settings.modelBaseUrl, "/responses", settings.modelFormat),
      payload: { model: settings.modelName.trim(), instructions: systemPrompt, input: userMessage, max_output_tokens: maxTokens },
    };
  }
  if (settings.modelFormat === "google") {
    return {
      endpoint: modelEndpoint(settings.modelBaseUrl, `/models/${encodeURIComponent(settings.modelName.trim())}:generateContent`, settings.modelFormat),
      payload: {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
      },
    };
  }
  return {
    endpoint: modelEndpoint(settings.modelBaseUrl, "/chat/completions", settings.modelFormat),
    payload: { model: settings.modelName.trim(), temperature: 0.1, max_tokens: maxTokens, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }] },
  };
}

interface ChatCompletion { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> }
interface AnthropicMessage { content?: Array<{ type?: string; text?: string }> }
interface OpenAIResponse { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
interface GeminiResponse { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }

function responseText(settings: Settings, body: string): string {
  const result = JSON.parse(body) as ChatCompletion & AnthropicMessage & OpenAIResponse & GeminiResponse;
  if (settings.modelFormat === "anthropic") return (result.content || []).filter(part => part.type === "text").map(part => part.text || "").join("\n");
  if (settings.modelFormat === "openai_responses") {
    return result.output_text
      || (result.output || []).flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text || "").join("\n");
  }
  if (settings.modelFormat === "google") return (result.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("\n");
  const content = result.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : (content || []).filter(part => part.type === "text").map(part => part.text || "").join("\n");
}

export interface ClassifyOptions {
  signal?: AbortSignal;
}

/**
 * 让模型在已有分类中选一个落点。
 * 分类为空时不调用模型，直接把文章放在根文档，避免无意义的请求与费用。
 */
export async function classifyArticle(
  title: string,
  markdown: string,
  categories: CategoryNode[],
  settings: Settings,
  options: ClassifyOptions = {},
): Promise<ClassificationResult> {
  if (!categories.length) return { categoryId: null, confidence: 0, reason: "没有已配置的分类" };
  if (!settings.modelKey.trim() || !settings.modelName.trim()) throw new Error("请配置模型 API Key 和模型名称");
  // 分类只需要主题信息；截断长文既省 token 也避免分类被正文细节带偏。
  const excerpt = markdown.slice(0, 4000);
  const userMessage = `已有分类：\n${JSON.stringify(classificationCandidates(categories), null, 1)}\n\n文章标题：${title}\n\n文章正文节选：\n${excerpt}`;
  const { endpoint, payload } = requestShape(settings, CLASSIFY_PROMPT, userMessage);
  const response = await proxyRequest(endpoint, "POST", headers(settings), payload, "text", 120000, options.signal);
  const text = responseText(settings, response.body);
  if (!text.trim()) throw new Error("模型没有返回分类结果");
  const parsed = extractJsonObject(text);
  const rawId = typeof parsed.collection_id === "string" ? parsed.collection_id.trim() : "";
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  const rawConfidence = Number(parsed.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
  if (!rawId) return { categoryId: null, confidence, reason: reason || "没有明确匹配的已有分类" };
  // 模型可能编造 ID，只有真实存在的分类才允许落库。
  const matched = categories.find(category => category.id === rawId);
  if (!matched) return { categoryId: null, confidence, reason: `模型返回了不存在的分类：${rawId}` };
  if (confidence < CLASSIFY_CONFIDENCE) return { categoryId: null, confidence, reason: reason || "分类置信度不足" };
  return { categoryId: matched.id, confidence, reason };
}

/** 分类、分类描述与审阅引用修复共用四种模型协议的短文本请求。 */
import { proxyRequest } from "../siyuan/api";
import { MODEL_SHORT_TIMEOUT_MS } from "../siyuan/timeouts";
import { throwIfServiceError } from "../siyuan/errors";
import { modelEndpoint } from "./endpoint";
import { headers } from "./provider-headers";
import { chatResponseContent, reasoningRequestOptions } from "./reasoning";
import type { Settings } from "../types";

function classifyOutputTokens(markdown: string): number {
  return Math.min(1024, Math.max(256, Math.ceil(markdown.length / 20)));
}

/** 按供应商协议组装请求体；分类只需要短输出，沿用审阅的协议适配避免重复实现。 */
function requestShape(settings: Settings, systemPrompt: string, userMessage: string, outputTokens?: number): { endpoint: string; payload: object } {
  const maxTokens = Math.min(2048, Math.max(128, outputTokens ?? classifyOutputTokens(userMessage)));
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
    payload: { model: settings.modelName.trim(), temperature: 0.1, max_tokens: maxTokens, ...reasoningRequestOptions(settings), messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }] },
  };
}

interface ChatCompletion { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> }
interface AnthropicMessage { content?: Array<{ type?: string; text?: string }> }
interface OpenAIResponse { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
interface GeminiResponse { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }

function responseText(settings: Settings, body: string): string {
  const result = JSON.parse(body) as ChatCompletion & AnthropicMessage & OpenAIResponse & GeminiResponse;
  throwIfServiceError(result);
  if (settings.modelFormat === "anthropic") return (result.content || []).filter(part => part.type === "text").map(part => part.text || "").join("\n");
  if (settings.modelFormat === "openai_responses") {
    return result.output_text
      || (result.output || []).flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text || "").join("\n");
  }
  if (settings.modelFormat === "google") return (result.candidates?.[0]?.content?.parts || []).filter(part => !part.thought).map(part => part.text || "").join("\n");
  const content = result.choices?.[0]?.message?.content;
  return chatResponseContent(content);
}

/** 只返回文字，不触发分类创建或任何思源写入。 */
export async function requestShortText(settings: Settings, systemPrompt: string, userMessage: string, signal?: AbortSignal, outputTokens?: number, timeoutMs = MODEL_SHORT_TIMEOUT_MS): Promise<string> {
  if (!settings.modelKey.trim() || !settings.modelName.trim()) throw new Error("请先配置模型 API Key 和模型名称");
  const { endpoint, payload } = requestShape(settings, systemPrompt, userMessage, outputTokens);
  const response = await proxyRequest(endpoint, "POST", headers(settings), payload, "text", timeoutMs, signal);
  const text = responseText(settings, response.body).trim();
  if (!text) throw new Error("模型没有返回内容");
  return text;
}

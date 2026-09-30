/** Review adapters for OpenAI Chat Completions and Anthropic Messages APIs. */
import { proxyRequest } from "../siyuan/api";
import type { Article, Settings } from "../types";

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
  error?: { message?: string };
}

interface AnthropicMessage {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

/** Normalize a configured API base to the format's message endpoint. */
export function modelEndpoint(baseUrl: string, suffix: "/chat/completions" | "/messages"): string {
  const endpoint = new URL(baseUrl.trim());
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("模型地址必须是 HTTP 或 HTTPS");
  const path = endpoint.pathname.replace(/\/$/, "");
  endpoint.pathname = path.endsWith(suffix) ? path : `${path}${path.endsWith("/v1") ? "" : "/v1"}${suffix}`;
  return endpoint.href;
}

/** Keep the editable draft separate from the crawler's original article. */
export async function reviewArticle(article: Article, settings: Settings): Promise<string> {
  if (!settings.modelKey.trim() || !settings.modelName.trim()) {
    throw new Error("请配置模型 API Key 和模型名称");
  }
  const userContent = `来源：${article.url}\n标题：${article.title}\n\n${article.markdown}`;
  if (settings.modelFormat === "anthropic") {
    const response = await proxyRequest(modelEndpoint(settings.modelBaseUrl, "/messages"), "POST", {
      "x-api-key": settings.modelKey.trim(),
      "anthropic-version": settings.anthropicVersion.trim() || "2023-06-01",
    }, {
      model: settings.modelName.trim(),
      max_tokens: 4096,
      system: settings.reviewPrompt.trim(),
      messages: [{ role: "user", content: userContent }],
    });
    const result = JSON.parse(response.body) as AnthropicMessage;
    const markdown = result.content?.filter(part => part.type === "text").map(part => part.text || "").join("\n");
    if (!markdown?.trim()) throw new Error(result.error?.message || "模型未返回审阅内容");
    return markdown.trim();
  }
  const response = await proxyRequest(modelEndpoint(settings.modelBaseUrl, "/chat/completions"), "POST", {
    Authorization: `Bearer ${settings.modelKey.trim()}`,
  }, {
    model: settings.modelName.trim(),
    temperature: 0.2,
    messages: [
      { role: "system", content: settings.reviewPrompt.trim() },
      { role: "user", content: userContent },
    ],
  });
  const result = JSON.parse(response.body) as ChatCompletion;
  const content = result.choices?.[0]?.message?.content;
  const markdown = typeof content === "string" ? content : content?.filter(part => part.type === "text").map(part => part.text || "").join("\n");
  if (!markdown?.trim()) throw new Error(result.error?.message || "模型未返回审阅内容");
  return markdown.trim();
}

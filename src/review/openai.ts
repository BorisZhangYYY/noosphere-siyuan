/** OpenAI Chat Completions compatible review adapter. */
import { proxyRequest } from "../siyuan/api";
import type { Article, Settings } from "../types";

interface Completion {
  choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
  error?: { message?: string };
}

/** Keep the editable draft separate from the crawler's original article. */
export async function reviewArticle(article: Article, settings: Settings): Promise<string> {
  if (!settings.modelKey.trim() || !settings.modelName.trim()) {
    throw new Error("请配置模型 API Key 和模型名称");
  }
  const base = new URL(settings.modelBaseUrl.trim());
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("模型地址必须是 HTTP 或 HTTPS");
  const endpoint = `${base.href.replace(/\/$/, "")}/chat/completions`;
  const response = await proxyRequest(endpoint, "POST", {
    Authorization: `Bearer ${settings.modelKey.trim()}`,
  }, {
    model: settings.modelName.trim(),
    temperature: 0.2,
    messages: [
      { role: "system", content: settings.reviewPrompt.trim() },
      { role: "user", content: `来源：${article.url}\n标题：${article.title}\n\n${article.markdown}` },
    ],
  });
  const result = JSON.parse(response.body) as Completion;
  const content = result.choices?.[0]?.message?.content;
  const markdown = typeof content === "string" ? content : content?.filter(part => part.type === "text").map(part => part.text || "").join("\n");
  if (!markdown?.trim()) throw new Error(result.error?.message || "模型未返回审阅内容");
  return markdown.trim();
}

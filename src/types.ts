/** Contracts shared by the capture, review and writing stages. */
export interface Settings {
  firecrawlKey: string;
  modelBaseUrl: string;
  modelKey: string;
  modelName: string;
  modelFormat: "openai_chat" | "anthropic";
  anthropicVersion: string;
  reviewPrompt: string;
  localizeImages: boolean;
  targetDocumentId: string;
}

export interface Article {
  url: string;
  title: string;
  markdown: string;
  author?: string;
  publishedAt?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  firecrawlKey: "",
  modelBaseUrl: "https://api.openai.com/v1",
  modelKey: "",
  modelName: "",
  modelFormat: "openai_chat",
  anthropicVersion: "2023-06-01",
  reviewPrompt: "请审阅并整理这篇文章：删除网页导航、广告和重复内容，修正明显的排版问题，保留事实、引用、链接、图片和原有结构。不要编造内容。只返回 Markdown 正文。",
  localizeImages: true,
  targetDocumentId: "",
};

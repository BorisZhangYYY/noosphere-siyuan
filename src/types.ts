/** Contracts shared by the capture, review and writing stages. */
export interface Settings {
  topBarPosition: "left" | "right";
  reviewPerspective: string;
  outputLanguage: import("./review/language").OutputLanguage;
  firecrawlKey: string;
  modelBaseUrl: string;
  modelKey: string;
  modelName: string;
  modelFormat: "openai_chat" | "openai_responses" | "anthropic" | "google";
  activeProvider: import("./review/providers").ProviderId;
  modelProfiles: Partial<Record<import("./review/providers").ProviderId, import("./review/providers").ModelProfile>>;
  imageProvider: import("./review/providers").ProviderId | "";
  imageReview: boolean;
  modelVisionCapable: boolean;
  customPerspectives: ReviewPerspective[];
  targetDocumentId: string;
  /** 分类根文档：自动分类落库的兜底位置，也是分类文档的父级。 */
  rootDocumentId: string;
  /** 手动指定文档保持原有追加语义；自动分类由 AI 选分类后按标题落库。 */
  saveMode: SaveMode;
}

export type SaveMode = "manual" | "auto";

export interface ReviewPerspective {
  id: string;
  label: string;
  description: string;
  prompt: string;
  template: string;
  sections?: ReviewSection[];
}

export interface ReviewSection {
  id: string;
  heading: string;
  instruction: string;
}

export interface Article {
  url: string;
  title: string;
  markdown: string;
  author?: string;
  publishedAt?: string;
  capturedAt?: string;
  /** 旧文章仅能恢复历史记录时间时单独保存，不作为真实抓取时间。 */
  recordedAt?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  topBarPosition: "right",
  reviewPerspective: "original",
  outputLanguage: "follow_ui",
  firecrawlKey: "",
  modelBaseUrl: "https://api.openai.com/v1",
  modelKey: "",
  modelName: "",
  modelFormat: "openai_chat",
  activeProvider: "custom",
  modelProfiles: {},
  imageProvider: "",
  imageReview: false,
  modelVisionCapable: false,
  customPerspectives: [],
  targetDocumentId: "",
  rootDocumentId: "",
  saveMode: "manual",
};

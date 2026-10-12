/** Contracts shared by the capture, review and writing stages. */
export interface Settings {
  topBarPosition: "left" | "right";
  reviewPerspective: string;
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
}

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
}

export const DEFAULT_SETTINGS: Settings = {
  topBarPosition: "right",
  reviewPerspective: "original",
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
};

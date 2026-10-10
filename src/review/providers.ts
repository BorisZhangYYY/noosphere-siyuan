/** Built-in provider profiles mirror Noosphere's supplier-first model setup. */
import type { Settings } from "../types";

export type ProviderId = "kimi_api" | "kimi_code" | "volcengine" | "minimax" | "zhipu" | "openai" | "anthropic" | "google" | "custom";
export interface ModelProfile {
  modelFormat: Settings["modelFormat"];
  modelBaseUrl: string;
  modelKey: string;
  modelName: string;
  modelVisionCapable: boolean;
}
export interface ProviderPreset extends ModelProfile {
  id: ProviderId;
  label: string;
  description: string;
  keyUrl: string;
}

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  kimi_api: { id: "kimi_api", label: "Kimi API", description: "月之暗面开放平台", modelFormat: "openai_chat", modelBaseUrl: "https://api.moonshot.cn/v1", modelKey: "", modelName: "", modelVisionCapable: false, keyUrl: "https://platform.kimi.com/console/api-keys" },
  kimi_code: { id: "kimi_code", label: "Kimi Code", description: "Kimi Code 控制台", modelFormat: "anthropic", modelBaseUrl: "https://api.kimi.com/coding/", modelKey: "", modelName: "kimi-for-coding", modelVisionCapable: false, keyUrl: "https://www.kimi.com/code/console" },
  volcengine: { id: "volcengine", label: "火山引擎", description: "火山方舟模型服务", modelFormat: "openai_chat", modelBaseUrl: "https://ark.cn-beijing.volces.com/api/v3", modelKey: "", modelName: "", modelVisionCapable: false, keyUrl: "https://ark.volcengine.com/region:cn-beijing/apikey" },
  minimax: { id: "minimax", label: "MiniMax", description: "MiniMax 开放平台", modelFormat: "openai_chat", modelBaseUrl: "https://api.minimaxi.com/v1", modelKey: "", modelName: "", modelVisionCapable: false, keyUrl: "https://platform.minimax.cn/console/access?tab=api-keys" },
  zhipu: { id: "zhipu", label: "智谱 AI", description: "智谱 BigModel", modelFormat: "openai_chat", modelBaseUrl: "https://open.bigmodel.cn/api/paas/v4", modelKey: "", modelName: "", modelVisionCapable: false, keyUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys" },
  openai: { id: "openai", label: "OpenAI", description: "OpenAI 官方接口", modelFormat: "openai_responses", modelBaseUrl: "https://api.openai.com/v1", modelKey: "", modelName: "", modelVisionCapable: false, keyUrl: "https://platform.openai.com/api-keys" },
  anthropic: { id: "anthropic", label: "Anthropic", description: "Claude 官方接口", modelFormat: "anthropic", modelBaseUrl: "https://api.anthropic.com/v1", modelKey: "", modelName: "", modelVisionCapable: false, keyUrl: "https://console.anthropic.com/settings/keys" },
  google: { id: "google", label: "Google Gemini", description: "Google AI Studio", modelFormat: "google", modelBaseUrl: "https://generativelanguage.googleapis.com/v1beta", modelKey: "", modelName: "", modelVisionCapable: false, keyUrl: "https://aistudio.google.com/app/apikey" },
  custom: { id: "custom", label: "自定义", description: "兼容 OpenAI、Anthropic 或 Gemini 的接口", modelFormat: "openai_chat", modelBaseUrl: "", modelKey: "", modelName: "", modelVisionCapable: false, keyUrl: "" },
};

export const PROVIDER_ORDER: ProviderId[] = ["kimi_api", "kimi_code", "volcengine", "minimax", "zhipu", "openai", "anthropic", "google", "custom"];

/** Copy only request settings, leaving presentation metadata outside persisted profiles. */
export function presetProfile(id: ProviderId): ModelProfile {
  const { modelFormat, modelBaseUrl, modelKey, modelName, modelVisionCapable } = PROVIDER_PRESETS[id];
  return { modelFormat, modelBaseUrl, modelKey, modelName, modelVisionCapable };
}

export function inferProvider(baseUrl: string): ProviderId {
  const value = baseUrl.toLowerCase();
  if (value.includes("api.kimi.com/coding")) return "kimi_code";
  if (value.includes("moonshot.cn")) return "kimi_api";
  if (value.includes("volces.com") || value.includes("volcengine")) return "volcengine";
  if (value.includes("minimaxi.com")) return "minimax";
  if (value.includes("bigmodel.cn")) return "zhipu";
  if (value.includes("api.openai.com")) return "openai";
  if (value.includes("api.anthropic.com")) return "anthropic";
  if (value.includes("generativelanguage.googleapis.com")) return "google";
  return "custom";
}

/** Move older flat model settings into one supplier profile without losing its key. */
export function restoreProviders(saved: Partial<Settings> | null): Pick<Settings, "activeProvider" | "modelProfiles" | "imageProvider" | "imageReview" | keyof ModelProfile> {
  const activeProvider = saved?.activeProvider && PROVIDER_PRESETS[saved.activeProvider]
    ? saved.activeProvider : saved?.modelBaseUrl ? inferProvider(saved.modelBaseUrl) : "kimi_api";
  const oldProfile: ModelProfile = saved?.modelBaseUrl
    ? { modelFormat: saved.modelFormat || "openai_chat", modelBaseUrl: saved.modelBaseUrl, modelKey: saved.modelKey || "", modelName: saved.modelName || "", modelVisionCapable: !!saved.modelVisionCapable }
    : presetProfile(activeProvider);
  const modelProfiles = { ...(saved?.modelProfiles || {}), [activeProvider]: saved?.modelProfiles?.[activeProvider] || oldProfile };
  const active = modelProfiles[activeProvider]!;
  const imageProvider = saved?.imageProvider || (saved?.imageReview && active.modelVisionCapable ? activeProvider : "");
  return { activeProvider, modelProfiles, imageProvider, imageReview: !!imageProvider, ...active };
}

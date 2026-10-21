/** Built-in provider profiles mirror Noosphere's supplier-first model setup. */
import type { Settings } from "../types";

export type BuiltinProviderId = "kimi_api" | "kimi_code" | "volcengine" | "minimax" | "zhipu" | "openai" | "anthropic" | "google";
export type ProviderId = BuiltinProviderId | "custom" | `custom_${string}`;
/** 自定义供应商使用稳定标识，改名不影响密钥和图片模型引用。 */
export interface CustomProvider { id: ProviderId; label: string }
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

export const PROVIDER_PRESETS: Record<BuiltinProviderId | "custom", ProviderPreset> = {
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

export const PROVIDER_ORDER: BuiltinProviderId[] = ["kimi_api", "kimi_code", "volcengine", "minimax", "zhipu", "openai", "anthropic", "google"];

/** 恢复排序时去重并移除已删除供应商，新增项追加到末尾。 */
export function orderedProviderIds(customProviders: CustomProvider[], savedOrder: readonly ProviderId[] = []): ProviderId[] {
  const available: ProviderId[] = [...PROVIDER_ORDER, ...customProviders.map(item => item.id)];
  return [...new Set([...savedOrder.filter(id => available.includes(id)), ...available])];
}

/** 仅移动顺序，不修改供应商标识、凭据或当前选择。 */
export function moveProvider(order: readonly ProviderId[], source: ProviderId, target: ProviderId, after = false): ProviderId[] {
  if (source === target || !order.includes(source) || !order.includes(target)) return [...order];
  const next = order.filter(id => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}

export function isCustomProvider(id: string): boolean {
  return id === "custom" || /^custom_[a-z0-9_-]+$/.test(id);
}

/** 合并内置与命名供应商；名称仅作显示，不作为存储键。 */
export function providerInfo(id: ProviderId, customProviders: CustomProvider[]): ProviderPreset {
  if (!isCustomProvider(id)) return PROVIDER_PRESETS[id as BuiltinProviderId];
  return { ...PROVIDER_PRESETS.custom, id, label: customProviders.find(item => item.id === id)?.label || "自定义" };
}

export function providerMark(id: ProviderId, label: string): string {
  return isCustomProvider(id) ? Array.from(label.trim()).slice(0, 2).join("").toLocaleUpperCase()
    : ({ kimi_api: "K", kimi_code: "C", volcengine: "火", minimax: "M", zhipu: "智", openai: "O", anthropic: "A", google: "G" } as Record<BuiltinProviderId, string>)[id as BuiltinProviderId];
}

/** 校验名称以免同一列表出现无法区分的供应商。 */
export function validateProviderName(label: string, customProviders: CustomProvider[], exceptId?: ProviderId): string {
  const name = label.trim();
  if (!name || Array.from(name).length > 40) throw new Error("供应商名称需要 1–40 个字符");
  const duplicate = [...PROVIDER_ORDER.map(id => ({ id, label: PROVIDER_PRESETS[id].label })), ...customProviders]
    .some(item => item.id !== exceptId && item.label.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (duplicate) throw new Error("供应商名称已存在");
  return name;
}

/** Copy only request settings, leaving presentation metadata outside persisted profiles. */
export function presetProfile(id: ProviderId): ModelProfile {
  const { modelFormat, modelBaseUrl, modelKey, modelName, modelVisionCapable } = isCustomProvider(id) ? PROVIDER_PRESETS.custom : PROVIDER_PRESETS[id as BuiltinProviderId];
  return { modelFormat, modelBaseUrl, modelKey, modelName, modelVisionCapable };
}

/** 忽略浏览时生成的空白预设，并统一字段与顺序，避免误报未保存。 */
export function configuredProfiles(profiles: Settings["modelProfiles"]): Settings["modelProfiles"] {
  const result: Settings["modelProfiles"] = {};
  for (const id of (Object.keys(profiles) as ProviderId[]).sort()) {
    const profile = profiles[id];
    if (!profile) continue;
    const preset = presetProfile(id);
    const normalized: ModelProfile = { modelFormat: profile.modelFormat, modelBaseUrl: profile.modelBaseUrl, modelKey: profile.modelKey, modelName: profile.modelName, modelVisionCapable: profile.modelVisionCapable };
    if (JSON.stringify(normalized) !== JSON.stringify(preset)) result[id] = normalized;
  }
  return result;
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
export function restoreProviders(saved: Partial<Settings> | null): Pick<Settings, "activeProvider" | "customProviders" | "providerOrder" | "modelProfiles" | "imageProvider" | "imageReview" | keyof ModelProfile> {
  const customProviders = (saved?.customProviders || []).filter((item, index, all) => item && isCustomProvider(item.id) && item.label?.trim() && all.findIndex(other => other?.id === item.id) === index)
    .map(item => ({ id: item.id, label: item.label.trim() }));
  const inferred = saved?.modelBaseUrl ? inferProvider(saved.modelBaseUrl) : "kimi_api";
  // 旧版单个“自定义”原位迁移，保留其凭据与图片审阅关联。
  if (!customProviders.some(item => item.id === "custom") && (saved?.activeProvider === "custom" || saved?.modelProfiles?.custom || inferred === "custom")) {
    customProviders.push({ id: "custom", label: "自定义" });
  }
  const ids: ProviderId[] = [...PROVIDER_ORDER, ...customProviders.map(item => item.id)];
  const activeProvider = saved?.activeProvider && ids.includes(saved.activeProvider) ? saved.activeProvider : inferred;
  const oldProfile: ModelProfile = saved?.modelBaseUrl
    ? { modelFormat: saved.modelFormat || "openai_chat", modelBaseUrl: saved.modelBaseUrl, modelKey: saved.modelKey || "", modelName: saved.modelName || "", modelVisionCapable: !!saved.modelVisionCapable }
    : presetProfile(activeProvider);
  const modelProfiles: Settings["modelProfiles"] = {};
  for (const id of ids) if (saved?.modelProfiles?.[id]) modelProfiles[id] = { ...saved.modelProfiles[id]! };
  modelProfiles[activeProvider] ||= oldProfile;
  const active = modelProfiles[activeProvider]!;
  const candidate = saved?.imageProvider || (saved?.imageReview && active.modelVisionCapable ? activeProvider : "");
  const imageProvider = candidate && ids.includes(candidate) && modelProfiles[candidate]?.modelVisionCapable ? candidate : "";
  return { activeProvider, customProviders, providerOrder: orderedProviderIds(customProviders, saved?.providerOrder), modelProfiles, imageProvider, imageReview: !!imageProvider, ...active };
}

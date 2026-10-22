/** 各模型协议的鉴权请求头；审阅、分类与配图共用，避免各自维护一份。 */
import type { Settings } from "../types";

const ANTHROPIC_VERSION = "2023-06-01";

export function headers(settings: Settings): Record<string, string> {
  if (settings.modelFormat === "anthropic") return { "x-api-key": settings.modelKey.trim(), "anthropic-version": ANTHROPIC_VERSION };
  if (settings.modelFormat === "google") return { "x-goog-api-key": settings.modelKey.trim() };
  return { Authorization: `Bearer ${settings.modelKey.trim()}` };
}

/** 来源平台展示名称独立于真实文章地址，保留原文链接用于打开与导入。 */
import { resolvePlatform } from "../crawler/platforms";

export function sourcePlatform(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return resolvePlatform(url)?.sourceName ?? url.hostname;
  } catch { return rawUrl; }
}

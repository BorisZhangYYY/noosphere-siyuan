/** 来源平台展示名称独立于真实文章地址，保留原文链接用于打开与导入。 */
export function sourcePlatform(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.toLocaleLowerCase();
    if (host === "mp.weixin.qq.com") return "微信公众号";
    if (/(^|\.)zhihu\.com$/.test(host)) return "知乎";
    return host;
  } catch { return rawUrl; }
}

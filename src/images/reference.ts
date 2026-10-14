/** 正文、素材和识图共用图片地址解析；思源资源不能拼到原网站下面。 */
export function localAssetPath(raw: string): string | null {
  const value = raw.trim().replace(/^<|>$/g, "");
  if (!/^\/?assets\//i.test(value)) return null;
  const url = new URL(value.startsWith("/") ? value : `/${value}`, "https://siyuan.invalid");
  return url.pathname.startsWith("/assets/") ? `${url.pathname}${url.search}${url.hash}` : null;
}

/** 本地图片使用当前思源资源路径，网页图片按文章地址解析。 */
export function resolveImageReference(raw: string, articleUrl: string): string {
  const local = localAssetPath(raw);
  if (local) return local;
  try {
    const url = new URL(raw.trim(), articleUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}

/** 微信同一资源的尺寸、协议和追踪参数不改变配图身份；其他来源保持原地址。 */
export function imageIdentity(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    if (url.hostname === "mmbiz.qpic.cn" && /^\/(?:sz_)?mmbiz_/.test(url.pathname)) {
      return `https://${url.hostname}${url.pathname.replace(/\/\d+$/, "")}`;
    }
    return url.href;
  } catch { return raw.split("#")[0]; }
}

/** 抓取器偶尔把文章链接写成图片，含片段的同页链接也不是配图。 */
export function isArticleImagePlaceholder(raw: string, articleUrl: string): boolean {
  if (localAssetPath(raw)) return false;
  try {
    const image = new URL(raw.trim().replace(/^<|>$/g, ""), articleUrl), article = new URL(articleUrl);
    image.hash = ""; article.hash = "";
    return image.href === article.href;
  } catch { return false; }
}

/** 清理错误的图片占位，普通文章链接、无扩展名的配图和原文其他内容继续保留。 */
export function stripArticleImagePlaceholders(markdown: string, articleUrl: string): string {
  return markdown.replace(/!\[[^\]]*\]\((<?[^\s)]+>?)(?:\s+"[^"]*")?\)/g, (full: string, raw: string) =>
    isArticleImagePlaceholder(raw, articleUrl) ? "" : full);
}

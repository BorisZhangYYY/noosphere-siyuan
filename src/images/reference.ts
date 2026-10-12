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

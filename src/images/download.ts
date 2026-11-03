/** 图片来源失效与模型/思源服务故障分开：单张坏链接可以跳过，服务故障仍需停止。 */
import { proxyRequest } from "../siyuan/api";
import { conciseRequestError, UpstreamHttpError } from "../siyuan/errors";
import { IMAGE_DOWNLOAD_TIMEOUT_MS } from "../siyuan/timeouts";

export class ImageUnavailableError extends Error {
  constructor(error: unknown) {
    super(conciseRequestError(error instanceof Error ? error.message : String(error)));
    this.name = "ImageUnavailableError";
  }
}

/** 明确的资源拒绝/失效可按单图处理；超时、限流和服务端故障不可误报为正常完成。 */
export function unavailableImageError(error: unknown): boolean {
  return error instanceof UpstreamHttpError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
}

/**
 * 知乎部分历史主机（pic-out 等）已对外封禁，但同一路径在镜像主机仍可取回。
 * 只在原地址明确失效时按序重试镜像，避免整篇文章的图片变成破图。
 */
const CDN_MIRRORS: Record<string, readonly string[]> = {
  "pic-out.zhimg.com": ["picx.zhimg.com", "pica.zhimg.com", "pic1.zhimg.com"],
  "pic1.zhimg.com": ["picx.zhimg.com", "pica.zhimg.com"],
  "pic2.zhimg.com": ["picx.zhimg.com", "pica.zhimg.com"],
  "pic3.zhimg.com": ["picx.zhimg.com", "pica.zhimg.com"],
};

/** 同路径的镜像候选地址；非已知 CDN 主机返回空数组。 */
export function mirrorUrls(url: string): string[] {
  try {
    const parsed = new URL(url);
    const hosts = CDN_MIRRORS[parsed.host] || [];
    return hosts.map(host => `${parsed.protocol}//${host}${parsed.pathname}${parsed.search}`);
  } catch { return []; }
}

export async function downloadRemoteImage(url: string, signal?: AbortSignal): Promise<{ body: string; contentType: string }> {
  const candidates = [url, ...mirrorUrls(url)];
  let lastError: unknown;
  for (const candidate of candidates) {
    try { return await proxyRequest(candidate, "GET", {}, undefined, "base64", IMAGE_DOWNLOAD_TIMEOUT_MS, signal); }
    catch (error) {
      // 取消、超时、限流和服务端故障都立即上抛，不能靠换主机掩盖。
      if (!unavailableImageError(error)) throw error;
      lastError = error;
    }
  }
  throw new ImageUnavailableError(lastError);
}

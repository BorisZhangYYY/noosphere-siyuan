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

export async function downloadRemoteImage(url: string, signal?: AbortSignal): Promise<{ body: string; contentType: string }> {
  try { return await proxyRequest(url, "GET", {}, undefined, "base64", IMAGE_DOWNLOAD_TIMEOUT_MS, signal); }
  catch (error) {
    if (unavailableImageError(error)) throw new ImageUnavailableError(error);
    throw error;
  }
}

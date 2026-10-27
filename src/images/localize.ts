/** Fetch article images through SiYuan and replace remote Markdown URLs with local assets. */
import { NetworkDisconnectedError, ProxyTimeoutError, requestWithTimeout, throwIfCancelled } from "../siyuan/api";
import { ServiceResponseError, throwIfServiceError, UpstreamHttpError } from "../siyuan/errors";
import { IMAGE_DOWNLOAD_TIMEOUT_MS, IMAGE_LOCALIZATION_TIMEOUT_MS } from "../siyuan/timeouts";
import { localAssetPath, stripArticleImagePlaceholders } from "./reference";
import { imageIdentity, resolveImageReference } from "./reference";
import { downloadRemoteImage } from "./download";

export interface LocalizationResult {
  markdown: string;
  localized: number;
  warnings: string[];
  assets?: Record<string, string>;
}

/** 明确的服务错误中止落库，同时把此前已成功上传的资源交还工作台保留。 */
export class ImageLocalizationError extends ServiceResponseError {
  constructor(readonly partial: LocalizationResult, error: ServiceResponseError) {
    super(error.code, error.message); this.name = "ImageLocalizationError";
  }
}

const IMAGE_PATTERN = /!\[([^\]]*)\]\((<?[^\s)]+>?)(?:\s+"[^"]*")?\)/g;

/** 同步其他保留稿中的已下载图片，不再次发起网络请求。 */
export function replaceImageAssetRefs(markdown: string, assets: Record<string, string>): string {
  return markdown.replace(IMAGE_PATTERN, (full, alt: string, raw: string) => {
    const local = assets[raw.replace(/^<|>$/g, "")];
    return local ? `![${alt}](${local})` : full;
  });
}

function fileExtension(contentType: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
    "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif",
  };
  return extensions[type] || "";
}

async function uploadImage(url: string, index: number, signal: AbortSignal): Promise<string> {
  const response = await downloadRemoteImage(url, signal);
  const extension = fileExtension(response.contentType);
  if (!extension) throw new Error(`不是支持的图片格式：${response.contentType}`);
  const binary = atob(response.body);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const file = new File([bytes], `noosphere-${Date.now()}-${index}.${extension}`, { type: response.contentType });
  const form = new FormData();
  form.append("assetsDirPath", "/assets/");
  form.append("file[]", file);
  const result = await requestWithTimeout(async requestSignal => {
    const uploaded = await fetch("/api/asset/upload", { method: "POST", body: form, signal: requestSignal });
    if (!uploaded.ok) throw new UpstreamHttpError(uploaded.status, "");
    return uploaded.json();
  }, IMAGE_DOWNLOAD_TIMEOUT_MS, signal) as {
    code: number; msg: string;
    data?: { succFiles?: Array<{ path: string }>; succMap?: Record<string, string> };
  };
  throwIfServiceError(result);
  const path = result.data?.succFiles?.[0]?.path || result.data?.succMap?.[file.name];
  if (result.code !== 0 || !path) throw new Error(result.msg || "思源未返回图片路径");
  return path;
}

/** Preserve remote links when an individual image cannot be downloaded. */
export async function localizeMarkdownImages(markdown: string, articleUrl: string, skippedImages: readonly string[] = []): Promise<LocalizationResult> {
  markdown = stripArticleImagePlaceholders(markdown, articleUrl);
  const matches = [...markdown.matchAll(IMAGE_PATTERN)];
  const warnings: string[] = [];
  const replacements = new Map<string, string>();
  const skipped = new Set(skippedImages.map(url => imageIdentity(resolveImageReference(url, articleUrl))));
  let localized = 0;
  const snapshot = (): LocalizationResult => ({ markdown: replaceImageAssetRefs(markdown, Object.fromEntries(replacements)), localized,
    warnings: [...warnings], assets: Object.fromEntries(replacements) });
  // 给整批本地化设置预算，避免断网后每张图各等一次超时；已有本地化结果继续使用。
  try {
    await requestWithTimeout(async signal => {
      for (const match of matches) {
        throwIfCancelled(signal);
        const original = match[2].replace(/^<|>$/g, "");
        if (replacements.has(original) || localAssetPath(original) || original.startsWith("data:")) continue;
        // 审阅已确认无法获取的图片保留原链接，不在保存时再次下载并阻塞整篇文章。
        if (skipped.has(imageIdentity(resolveImageReference(original, articleUrl)))) continue;
        try {
          const url = new URL(original, articleUrl);
          if (!["http:", "https:"].includes(url.protocol)) throw new Error("非 HTTP 图片地址");
          const path = await uploadImage(url.href, localized, signal);
          throwIfCancelled(signal);
          replacements.set(original, path);
          localized++;
        } catch (error) {
          throwIfCancelled(signal);
          if (error instanceof ServiceResponseError) throw error;
          warnings.push(`图片 ${original}：${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof ProxyTimeoutError || error instanceof NetworkDisconnectedError || error instanceof TypeError) break;
        }
      }
    }, IMAGE_LOCALIZATION_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof ServiceResponseError) throw new ImageLocalizationError(snapshot(), error);
    warnings.push(`图片保存已停止：${error instanceof Error ? error.message : String(error)}；未完成的图片保留原链接。`);
  }
  return snapshot();
}

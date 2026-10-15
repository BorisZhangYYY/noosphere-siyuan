/** Fetch article images through SiYuan and replace remote Markdown URLs with local assets. */
import { proxyRequest } from "../siyuan/api";
import { localAssetPath, stripArticleImagePlaceholders } from "./reference";

export interface LocalizationResult {
  markdown: string;
  localized: number;
  warnings: string[];
  assets?: Record<string, string>;
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

async function uploadImage(url: string, index: number): Promise<string> {
  const response = await proxyRequest(url, "GET", {}, undefined, "base64");
  const extension = fileExtension(response.contentType);
  if (!extension) throw new Error(`不是支持的图片格式：${response.contentType}`);
  const binary = atob(response.body);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const file = new File([bytes], `noosphere-${Date.now()}-${index}.${extension}`, { type: response.contentType });
  const form = new FormData();
  form.append("assetsDirPath", "/assets/");
  form.append("file[]", file);
  const uploaded = await fetch("/api/asset/upload", { method: "POST", body: form });
  if (!uploaded.ok) throw new Error(`思源图片上传失败：HTTP ${uploaded.status}`);
  const result = await uploaded.json() as {
    code: number; msg: string;
    data?: { succFiles?: Array<{ path: string }>; succMap?: Record<string, string> };
  };
  const path = result.data?.succFiles?.[0]?.path || result.data?.succMap?.[file.name];
  if (result.code !== 0 || !path) throw new Error(result.msg || "思源未返回图片路径");
  return path;
}

/** Preserve remote links when an individual image cannot be downloaded. */
export async function localizeMarkdownImages(markdown: string, articleUrl: string): Promise<LocalizationResult> {
  markdown = stripArticleImagePlaceholders(markdown, articleUrl);
  const matches = [...markdown.matchAll(IMAGE_PATTERN)];
  const warnings: string[] = [];
  const replacements = new Map<string, string>();
  let localized = 0;
  // 按整篇处理图片，不因图片较多而截断保存；已有本地资源不重复下载。
  for (const match of matches) {
    const original = match[2].replace(/^<|>$/g, "");
    if (replacements.has(original) || localAssetPath(original) || original.startsWith("data:")) continue;
    try {
      const url = new URL(original, articleUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("非 HTTP 图片地址");
      replacements.set(original, await uploadImage(url.href, localized));
      localized += 1;
    } catch (error) {
      warnings.push(`图片 ${original}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const output = replaceImageAssetRefs(markdown, Object.fromEntries(replacements));
  return { markdown: output, localized, warnings, assets: Object.fromEntries(replacements) };
}

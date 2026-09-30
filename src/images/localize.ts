/** Fetch article images through SiYuan and replace remote Markdown URLs with local assets. */
import { proxyRequest } from "../siyuan/api";

export interface LocalizationResult {
  markdown: string;
  localized: number;
  warnings: string[];
}

const IMAGE_PATTERN = /!\[([^\]]*)\]\((<?[^\s)]+>?)(?:\s+"[^"]*")?\)/g;
const MAX_IMAGES = 30;
const MAX_BASE64_LENGTH = 14_000_000;

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
  if (response.body.length > MAX_BASE64_LENGTH) throw new Error("图片超过 10 MB 限制");
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
  const matches = [...markdown.matchAll(IMAGE_PATTERN)];
  const warnings: string[] = [];
  const replacements = new Map<string, string>();
  let localized = 0;
  for (const match of matches.slice(0, MAX_IMAGES)) {
    const original = match[2].replace(/^<|>$/g, "");
    if (replacements.has(original) || original.startsWith("assets/") || original.startsWith("data:")) continue;
    try {
      const url = new URL(original, articleUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("非 HTTP 图片地址");
      replacements.set(original, await uploadImage(url.href, localized));
      localized += 1;
    } catch (error) {
      warnings.push(`图片 ${original}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (matches.length > MAX_IMAGES) warnings.push(`仅处理前 ${MAX_IMAGES} 张图片，其余保留原链接`);
  const output = markdown.replace(IMAGE_PATTERN, (full, alt: string, raw: string) => {
    const original = raw.replace(/^<|>$/g, "");
    return replacements.has(original) ? `![${alt}](${replacements.get(original)})` : full;
  });
  return { markdown: output, localized, warnings };
}

/** 将代理错误转换为短诊断；响应编码、错误网页和长数据不进入用户提示。 */
const DETAIL_LIMIT = 160;

function defaultDetail(status: number): string {
  if (status === 403) return "请求被拒绝";
  if (status === 401) return "身份验证未通过";
  if (status === 429) return "请求过于频繁，请稍后重试";
  return status >= 500 ? "服务暂时不可用" : "请求失败";
}

/** 先解码再读取 JSON 错误，HTML 拦截页只保留状态含义。 */
function responseDetail(status: number, body: string, encoding: "text" | "base64"): string {
  let text = body;
  if (encoding === "base64") {
    try { text = new TextDecoder().decode(Uint8Array.from(atob(body), char => char.charCodeAt(0))); }
    catch { return defaultDetail(status); }
  }
  try {
    const data = JSON.parse(text) as { error?: string | { message?: string }; message?: string; msg?: string };
    const detail = typeof data.error === "string" ? data.error : data.error?.message;
    text = detail || data.message || data.msg || defaultDetail(status);
  } catch { /* 非 JSON 仅保留简短纯文本，不能把错误页当成错误原因。 */ }
  if (typeof text !== "string" || /<!doctype|<html|<head|<body|<script|<title/i.test(text)) return defaultDetail(status);
  return text.replace(/\s+/g, " ").trim().slice(0, DETAIL_LIMIT) || defaultDetail(status);
}

export class UpstreamHttpError extends Error {
  constructor(readonly status: number, body: string, encoding: "text" | "base64" = "text") {
    super(`上游服务返回 HTTP ${status}：${responseDetail(status, body, encoding)}`);
    this.name = "UpstreamHttpError";
  }
}

/** 旧草稿可能已有截断的 Base64 错误网页，恢复时也缩短为可读提示。 */
export function conciseRequestError(message: string): string {
  const http = message.match(/^(.*?上游服务返回 HTTP (\d+)：)([\s\S]*)$/);
  if (!http) return message.replace(/\s+/g, " ").trim().slice(0, 240);
  const body = http[3].trim();
  const encoding = /^[A-Za-z0-9+/]+={0,2}$/.test(body) && body.length >= 40 ? "base64" : "text";
  return `${http[1]}${responseDetail(Number(http[2]), body, encoding)}`;
}

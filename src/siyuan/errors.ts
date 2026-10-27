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

/** 明确的服务错误保留原始代码，调用方不可将其当作空结果重试或默认成功。 */
export class ServiceResponseError extends Error {
  constructor(readonly code: string | number, message: string) { super(message); this.name = "ServiceResponseError"; }
}

export class UpstreamHttpError extends ServiceResponseError {
  constructor(readonly status: number, body: string, encoding: "text" | "base64" = "text") {
    super(status, `上游服务返回 HTTP ${status}：${responseDetail(status, body, encoding)}`);
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

/** 只检查服务信封字段，不递归进入文章正文、choices 内容或用户数据。 */
export function throwIfServiceError(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const object = (item: unknown): Record<string, unknown> => item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
  const text = (...items: unknown[]): string => items.find(item => typeof item === "string" && item.trim()) as string || "";
  const errorCode = (code: unknown): code is string | number => {
    if (typeof code !== "number" && typeof code !== "string") return false;
    const normalized = String(code).trim();
    if (!normalized || /^(?:ok|success|succeeded)$/i.test(normalized)) return false;
    if (/^-?\d+$/.test(normalized)) { const number = Number(normalized); return number !== 0 && (number < 200 || number >= 300); }
    return true;
  };
  const error = object(record.error);
  const hasError = typeof record.error === "string" ? !!record.error.trim()
    : record.error === true || typeof record.error === "number" && record.error !== 0 || Object.keys(error).length > 0;
  const codes = [error.code, error.error_code, error.status_code, error.status, typeof record.error === "number" ? record.error : undefined, record.error_code, record.errorCode, record.code, record.status_code, record.statusCode];
  const code = codes.find(errorCode);
  const failedStatus = typeof record.status === "string"
    && /^(?:error|failed|failure|cancelled|canceled|rejected|unavailable|unauthorized|permission_denied|resource_exhausted|invalid_argument|not_found|internal|deadline_exceeded|overloaded)$/i.test(record.status);
  const statusCode = typeof record.status === "number" || typeof record.status === "string" && /^-?\d+$/.test(record.status)
    ? record.status : undefined;
  if (hasError || code !== undefined || record.success === false || record.ok === false || record.status === false || failedStatus || record.type === "error" || errorCode(statusCode)) {
    const rawCode = code ?? ((errorCode(statusCode) ? statusCode : text(error.type, failedStatus ? record.status : "")) || "ERROR");
    const safeCode = String(rawCode).replace(/[<>\r\n]/g, "").slice(0, 80);
    const message = text(error.message, error.msg, error.detail, typeof record.error === "string" ? record.error : "", record.message, record.msg, record.status_msg);
    const detail = /<!doctype|<html|<script|<body/i.test(message) ? "服务请求失败" : message.replace(/\s+/g, " ").trim().slice(0, DETAIL_LIMIT) || "服务请求失败";
    throw new ServiceResponseError(typeof rawCode === "number" ? rawCode : safeCode, `服务返回错误 ${safeCode}：${detail}`);
  }
  // MiniMax 的业务码与 Responses 的事件信封都属于协议元数据。
  if (record.base_resp) throwIfServiceError(record.base_resp);
  if (record.response) throwIfServiceError(record.response);
}

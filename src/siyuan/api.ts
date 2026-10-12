/** Narrow wrapper for the public SiYuan kernel APIs used by this plugin. */
export interface KernelResponse<T> {
  code: number;
  msg: string;
  data: T;
}

/** 同时约束本地连接和思源代理的等待，避免代理断线后一直停留在处理中。 */
export async function kernelPost<T>(path: string, payload: unknown, timeoutMs?: number): Promise<T> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = timeoutMs ? setTimeout(() => controller!.abort(), timeoutMs) : undefined;
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) throw new Error(`思源请求失败：HTTP ${response.status}`);
    const result = await response.json() as KernelResponse<T>;
    if (result.code !== 0) throw new Error(result.msg || `思源接口错误：${result.code}`);
    return result.data;
  } finally { if (timer) clearTimeout(timer); }
}

export class ProxyTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`请求超时，未收到完整响应（等待上限 ${Math.round(timeoutMs / 1000)} 秒）`);
    this.name = "ProxyTimeoutError";
  }
}

export interface ProxyResponse {
  body: string;
  status: number;
  contentType: string;
}

export async function proxyRequest(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string> = {},
  payload?: unknown,
  responseEncoding: "text" | "base64" = "text",
  timeoutMs = 60000,
): Promise<ProxyResponse> {
  let data: ProxyResponse;
  try {
    data = await kernelPost<ProxyResponse>("/api/network/forwardProxy", {
      url,
      method,
      timeout: timeoutMs,
      contentType: "application/json",
      headers: [headers],
      ...(payload === undefined ? {} : { payload, payloadEncoding: "json" }),
      responseEncoding,
    }, timeoutMs + 5000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error instanceof Error && error.name === "AbortError") || /timeout|timed out|deadline exceeded|超时|HTTP (?:408|504|524)/i.test(message)) throw new ProxyTimeoutError(timeoutMs);
    throw error;
  }
  if (data.status < 200 || data.status >= 300) {
    if ([408, 504, 524].includes(data.status)) throw new ProxyTimeoutError(timeoutMs);
    let detail = data.body.slice(0, 240);
    try {
      const error = JSON.parse(data.body) as { error?: string | { message?: string }; message?: string };
      detail = (typeof error.error === "string" ? error.error : error.error?.message) || error.message || detail;
    } catch { /* Keep the response snippet when it is not JSON. */ }
    throw new Error(`上游服务返回 HTTP ${data.status}：${detail}`);
  }
  return data;
}

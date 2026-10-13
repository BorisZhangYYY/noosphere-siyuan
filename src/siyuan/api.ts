/** Narrow wrapper for the public SiYuan kernel APIs used by this plugin. */
import { fetchReviewStream } from "./stream";
import { UpstreamHttpError } from "./errors";
export interface KernelResponse<T> {
  code: number;
  msg: string;
  data: T;
}

/** 同时约束本地连接和思源代理的等待，避免代理断线后一直停留在处理中。 */
export async function kernelPost<T>(path: string, payload: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  throwIfCancelled(signal);
  const { controller, cleanup } = requestController(timeoutMs, signal);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    throwIfCancelled(signal);
    if (!response.ok) throw new Error(`思源请求失败：HTTP ${response.status}`);
    const result = await response.json() as KernelResponse<T>;
    throwIfCancelled(signal);
    if (result.code !== 0) throw new Error(result.msg || `思源接口错误：${result.code}`);
    return result.data;
  } catch (error) { throwIfCancelled(signal); throw error; }
  finally { cleanup(); }
}

/** 用户取消与超时分开处理，取消不显示失败提示。 */
export class RequestCancelledError extends Error {
  constructor() { super("审阅已取消"); this.name = "RequestCancelledError"; }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RequestCancelledError();
}

/** 将界面取消信号接到各 HTTP 请求，同时保留原有等待上限。 */
function requestController(timeoutMs?: number, signal?: AbortSignal): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = timeoutMs ? setTimeout(abort, timeoutMs) : undefined;
  return { controller, cleanup: () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
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

/** 旧内核没有流式代理时，由审阅层明确降级为普通响应。 */
export class StreamProxyUnavailableError extends Error {}

/** 思源代理参数要求无填充的 URL-safe Base64，按 UTF-8 编码保留中文。 */
function proxyParameter(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 使用原始响应代理读取真实数据流，保持浏览器前端无需跨域直连供应商。 */
export async function proxyStreamRequest(
  url: string, headers: Record<string, string>, payload: unknown,
  onChunk: (chunk: string) => void, timeoutMs = 300000, signal?: AbortSignal,
): Promise<string> {
  throwIfCancelled(signal);
  const params = new URLSearchParams({ u: proxyParameter(url),
    h: proxyParameter(JSON.stringify(Object.fromEntries(Object.entries({ ...headers, Accept: "text/event-stream" }).map(([key, value]) => [key, [value]])))),
    t: `${timeoutMs}ms` });
  const { controller, cleanup } = requestController(timeoutMs, signal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetchReviewStream(`/api/network/proxy?${params}`, JSON.stringify(payload), controller.signal);
    throwIfCancelled(signal);
    if ([404, 405, 501].includes(response.status) && !response.headers.get("Siyuan-Proxy-Content-Type")) {
      throw new StreamProxyUnavailableError("当前思源内核不支持流式代理");
    }
    if (!response.ok) {
      if ([408, 504, 524].includes(response.status)) throw new ProxyTimeoutError(timeoutMs);
      throw new UpstreamHttpError(response.status, await response.text());
    }
    if (!response.body) throw new Error("模型接口未返回可读取的响应体");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (true) {
      const { value, done } = await reader.read();
      throwIfCancelled(signal);
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      body += chunk;
      if (chunk) onChunk(chunk);
      if (done) return body;
    }
  } catch (error) {
    controller.abort();
    throwIfCancelled(signal);
    if (error instanceof Error && error.name === "AbortError") throw new ProxyTimeoutError(timeoutMs);
    throw error;
  } finally {
    cleanup();
    if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}

export async function proxyRequest(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string> = {},
  payload?: unknown,
  responseEncoding: "text" | "base64" = "text",
  timeoutMs = 60000,
  signal?: AbortSignal,
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
    }, timeoutMs + 5000, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error instanceof Error && error.name === "AbortError") || /timeout|timed out|deadline exceeded|超时|HTTP (?:408|504|524)/i.test(message)) throw new ProxyTimeoutError(timeoutMs);
    throw error;
  }
  if (data.status < 200 || data.status >= 300) {
    if ([408, 504, 524].includes(data.status)) throw new ProxyTimeoutError(timeoutMs);
    throw new UpstreamHttpError(data.status, data.body, responseEncoding);
  }
  return data;
}

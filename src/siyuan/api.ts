/** Narrow wrapper for the public SiYuan kernel APIs used by this plugin. */
import { fetchReviewStream } from "./stream";
import { ServiceResponseError, throwIfServiceError, UpstreamHttpError } from "./errors";
import { KERNEL_TIMEOUT_MS, REVIEW_IDLE_TIMEOUT_MS } from "./timeouts";
export interface KernelResponse<T> {
  code: number;
  msg: string;
  data: T;
}

/** 不只发送 abort：即使宿主连接没有响应取消，也必须让调用方在截止时退出。 */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let cleanup: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => reject(signal.reason || new RequestCancelledError());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    cleanup = () => signal.removeEventListener("abort", abort);
  });
  return Promise.race([operation, aborted]).finally(cleanup);
}

/** 覆盖请求、响应体读取与超时清理；迟到的响应不能继续调用方的业务流程。 */
export async function requestWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = KERNEL_TIMEOUT_MS, signal?: AbortSignal, onSlowResponse?: () => void): Promise<T> {
  throwIfCancelled(signal);
  const scope = requestController(timeoutMs, signal, onSlowResponse ? REVIEW_IDLE_TIMEOUT_MS : undefined, onSlowResponse);
  try { return await abortable(operation(scope.controller.signal), scope.controller.signal); }
  catch (error) {
    throwIfCancelled(signal);
    if (scope.controller.signal.aborted) throw scope.controller.signal.reason;
    scope.controller.abort(error);
    throw error;
  } finally { scope.cleanup(); }
}

/** 思源普通请求默认 30 秒，显式代理请求仍按各阶段的等待上限执行。 */
export async function kernelPost<T>(path: string, payload: unknown, timeoutMs = KERNEL_TIMEOUT_MS, signal?: AbortSignal, onSlowResponse?: () => void): Promise<T> {
  return requestWithTimeout(async requestSignal => {
    const response = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: requestSignal,
    });
    if (!response.ok) throw new UpstreamHttpError(response.status, "");
    const result = await response.json() as KernelResponse<T>;
    if (result.code !== 0) throw new ServiceResponseError(result.code ?? "INVALID_RESPONSE", `思源接口错误 ${result.code}：${result.msg || "请求失败"}`);
    return result.data;
  }, timeoutMs, signal, onSlowResponse);
}

/** 网络中断保留为可继续的失败，不能被误报成用户取消或长时间等待。 */
export class NetworkDisconnectedError extends Error {
  constructor() { super("网络已断开，请恢复连接后继续"); this.name = "NetworkDisconnectedError"; }
}

/** 用户取消与超时分开处理，取消不显示失败提示。 */
export class RequestCancelledError extends Error {
  constructor() { super("审阅已取消"); this.name = "RequestCancelledError"; }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RequestCancelledError();
}

/** 将界面取消信号接到各 HTTP 请求，同时保留原有等待上限。 */
function requestController(timeoutMs?: number, signal?: AbortSignal, idleTimeoutMs?: number, onIdle?: () => void): { controller: AbortController; cleanup: () => void; touch: () => void; progress: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new RequestCancelledError());
  const offline = (): void => controller.abort(new NetworkDisconnectedError());
  globalThis.addEventListener?.("offline", offline, { once: true });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const progress = (): void => {
    if (timer) clearTimeout(timer);
    if (timeoutMs && !controller.signal.aborted) timer = setTimeout(() => controller.abort(new ProxyTimeoutError(timeoutMs)), timeoutMs);
  };
  progress();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleTimeoutMs && !controller.signal.aborted) idleTimer = setTimeout(() => {
      // 长文的静默可能是服务端思考；有慢响应回调时只提醒，仍受独立的总上限约束。
      if (!onIdle) { controller.abort(new ProxyTimeoutError(idleTimeoutMs)); return; }
      try { onIdle(); } catch (error) { controller.abort(error); }
    }, idleTimeoutMs);
  };
  touch();
  return { controller, touch, progress, cleanup: () => {
    if (timer) clearTimeout(timer);
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener("abort", abort); globalThis.removeEventListener?.("offline", offline);
  } };
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
  onChunk: (chunk: string) => void | boolean, timeoutMs = 300000, signal?: AbortSignal, idleTimeoutMs = REVIEW_IDLE_TIMEOUT_MS, onSlowResponse?: () => void,
  renewOnProgress = false,
): Promise<string> {
  throwIfCancelled(signal);
  const params = new URLSearchParams({ u: proxyParameter(url),
    h: proxyParameter(JSON.stringify(Object.fromEntries(Object.entries({ ...headers, Accept: "text/event-stream" }).map(([key, value]) => [key, [value]])))),
    t: `${timeoutMs}ms` });
  const { controller, cleanup, touch, progress } = requestController(timeoutMs, signal, idleTimeoutMs, onSlowResponse);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await abortable(fetchReviewStream(`/api/network/proxy?${params}`, JSON.stringify(payload), controller.signal), controller.signal);
    throwIfCancelled(signal);
    if ([404, 405, 501].includes(response.status) && !response.headers.get("Siyuan-Proxy-Content-Type")) {
      throw new StreamProxyUnavailableError("当前思源内核不支持流式代理");
    }
    if (!response.ok) {
      // 状态码已确认失败，立即结束；不能再为了读取错误正文等待模型超时。
      if (response.body) void response.body.cancel().catch(() => undefined);
      throw new UpstreamHttpError(response.status, "");
    }
    if (!response.body) throw new Error("模型接口未返回可读取的响应体");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (true) {
      const { value, done } = await abortable(reader.read(), controller.signal);
      throwIfCancelled(signal);
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      body += chunk;
      if (chunk) {
        touch();
        // 生成进展由协议解析器确认；原始字节、心跳和空事件不能延长此期限。
        if (onChunk(chunk) === true && renewOnProgress) progress();
      }
      if (done) return body;
    }
  } catch (error) {
    controller.abort();
    throwIfCancelled(signal);
    if (controller.signal.reason instanceof NetworkDisconnectedError || controller.signal.reason instanceof ProxyTimeoutError) throw controller.signal.reason;
    if (error instanceof Error && error.name === "AbortError") throw new ProxyTimeoutError(timeoutMs);
    throw error;
  } finally {
    cleanup();
    if (reader) {
      // 异常连接的取消也可能挂起，不能阻止工作台解除忙碌状态。
      const current = reader;
      void current.cancel().catch(() => undefined).finally(() => { try { current.releaseLock(); } catch { /* 已失效的连接无需再次释放。 */ } });
    }
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
  onSlowResponse?: () => void,
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
    }, timeoutMs + 5000, signal, onSlowResponse);
  } catch (error) {
    if (error instanceof ServiceResponseError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if ((error instanceof Error && error.name === "AbortError") || /timeout|timed out|deadline exceeded|超时|HTTP (?:408|504|524)/i.test(message)) throw new ProxyTimeoutError(timeoutMs);
    throw error;
  }
  if (data.status < 200 || data.status >= 300) {
    throw new UpstreamHttpError(data.status, data.body, responseEncoding);
  }
  // 某些供应商以 HTTP 200 包装业务错误，不能把错误信封交给后续解析当作正常内容。
  if (responseEncoding === "text" || /json/i.test(data.contentType || "")) {
    try {
      const body = responseEncoding === "base64" ? new TextDecoder().decode(Uint8Array.from(atob(data.body), char => char.charCodeAt(0))) : data.body;
      throwIfServiceError(JSON.parse(body));
    } catch (error) { if (error instanceof ServiceResponseError) throw error; }
  }
  return data;
}

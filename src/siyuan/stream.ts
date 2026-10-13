/** 桌面端以原生 HTTP 连接思源，关闭代理响应压缩，让增量内容及时到达。 */
interface NativeRequest {
  on(event: string, listener: (error: Error) => void): NativeRequest;
  end(body: string): void;
  destroy(): void;
}
interface NativeResponse {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: any[]) => void): NativeResponse;
  pause(): void;
  resume(): void;
  destroy(): void;
}
interface NativeHttp {
  request(url: string, options: { method: string; headers: Record<string, string>; ca?: string; rejectUnauthorized?: true }, callback: (response: NativeResponse) => void): NativeRequest;
}
interface DesktopWindow {
  require?: (name: string) => unknown;
  siyuan?: { config?: { api?: { token?: string }; system?: { workspaceDir?: string; confDir?: string } } };
}

/** 仅为当前本机内核信任工作空间的 CA，不修改全局信任链或关闭证书校验。 */
function localKernelCA(desktop: DesktopWindow, url: URL): string | undefined {
  const system = desktop.siyuan?.config?.system;
  if (url.protocol !== "https:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !desktop.require || !system) return undefined;
  const fs = desktop.require("fs") as { readFileSync(path: string, encoding: "utf8"): string };
  const path = desktop.require("path") as { join(...parts: string[]): string };
  const confDir = system.confDir || (system.workspaceDir ? path.join(system.workspaceDir, "conf") : "");
  if (!confDir) return undefined;
  try { return fs.readFileSync(path.join(confDir, "ca.crt"), "utf8"); }
  catch { return undefined; /* 未找到本机 CA 时仍使用默认校验，绝不跳过 TLS 验证。 */ }
}

/** 浏览器保留同源代理；桌面端只把思源令牌发送给当前思源内核。 */
export async function fetchReviewStream(path: string, body: string, signal: AbortSignal): Promise<Response> {
  const desktop = typeof window === "undefined" ? undefined : window as unknown as DesktopWindow;
  const token = desktop?.siyuan?.config?.api?.token;
  let http: NativeHttp | undefined, url: URL | undefined, ca: string | undefined;
  if (desktop) {
    url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin) throw new Error("流式审阅代理必须连接当前思源内核");
  }
  if (desktop?.require && token) {
    try {
      if (url && ["http:", "https:"].includes(url.protocol)) {
        http = desktop.require(url.protocol === "https:" ? "https" : "http") as NativeHttp;
        ca = localKernelCA(desktop, url);
      }
    } catch { /* 宿主未提供原生 HTTP 时仍使用浏览器代理。 */ }
  }
  if (!http?.request || !url || !token) return fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body, signal,
  });
  return new Promise<Response>((resolve, reject) => {
    let request: NativeRequest | undefined, response: NativeResponse | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true; cleanup();
      if (streamController) streamController.error(error);
      reject(error);
      response?.destroy(); request?.destroy();
    };
    const abort = (): void => fail(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    try {
      request = http!.request(url!.href, {
        ...(url!.protocol === "https:" ? { rejectUnauthorized: true as const, ...(ca ? { ca } : {}) } : {}),
        method: "POST", headers: {
          "Content-Type": "application/json", Accept: "text/event-stream", "Accept-Encoding": "identity",
          "Content-Length": String(new TextEncoder().encode(body).length), Authorization: `Token ${token}`,
        },
      }, incoming => {
        response = incoming;
        if (signal.aborted || finished) { incoming.destroy(); return; }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            incoming.on("data", (chunk: Uint8Array) => {
              if (finished) return;
              controller.enqueue(new Uint8Array(chunk));
              if ((controller.desiredSize || 0) <= 0) incoming.pause();
            });
            incoming.on("end", () => { if (!finished) { finished = true; cleanup(); controller.close(); } });
            incoming.on("error", fail);
            incoming.on("aborted", () => fail(new Error("思源流式连接提前中断")));
            incoming.on("close", () => { if (!finished) fail(new Error("思源流式连接提前中断")); });
          },
          pull() { incoming.resume(); },
          cancel() { finished = true; cleanup(); incoming.destroy(); request?.destroy(); },
        });
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          resolve(new Response(stream, { status: incoming.statusCode || 502, headers }));
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
      request.on("error", fail);
      request.end(body);
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}

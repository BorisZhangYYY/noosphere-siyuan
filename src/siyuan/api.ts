/** Narrow wrapper for the public SiYuan kernel APIs used by this plugin. */
export interface KernelResponse<T> {
  code: number;
  msg: string;
  data: T;
}

export async function kernelPost<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`思源请求失败：HTTP ${response.status}`);
  const result = await response.json() as KernelResponse<T>;
  if (result.code !== 0) throw new Error(result.msg || `思源接口错误：${result.code}`);
  return result.data;
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
): Promise<ProxyResponse> {
  const data = await kernelPost<ProxyResponse>("/api/network/forwardProxy", {
    url,
    method,
    timeout: 60000,
    contentType: "application/json",
    headers: [headers],
    ...(payload === undefined ? {} : { payload, payloadEncoding: "json" }),
    responseEncoding,
  });
  if (data.status < 200 || data.status >= 300) {
    let detail = data.body.slice(0, 240);
    try {
      const error = JSON.parse(data.body) as { error?: string; message?: string };
      detail = error.error || error.message || detail;
    } catch { /* Keep the response snippet when it is not JSON. */ }
    throw new Error(`上游服务返回 HTTP ${data.status}：${detail}`);
  }
  return data;
}

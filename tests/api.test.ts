/** 思源代理的超时、错误分类和浏览器连接截止时间验证。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyRequest, ProxyTimeoutError, RequestCancelledError } from "../src/siyuan/api";
import { conciseRequestError, UpstreamHttpError } from "../src/siyuan/errors";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("SiYuan proxy timeout", () => {
  it("decodes a forbidden image response without printing its HTML or Base64", async () => {
    const body = btoa('    <!DOCTYPE html><html><head><title>Forbidden</title></head><body>' + 'x'.repeat(4000) + '</body></html>');
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 403, body, contentType: "text/html" } }) })));
    await expect(proxyRequest("https://example.com/photo", "GET", {}, undefined, "base64")).rejects.toThrow("上游服务返回 HTTP 403：请求被拒绝");
    expect(conciseRequestError(`上游服务返回 HTTP 403：${body.slice(0, 240)}`)).toBe("上游服务返回 HTTP 403：请求被拒绝");
  });

  it("keeps a bounded provider diagnosis for both response encodings", () => {
    const text = JSON.stringify({ error: { message: "没有权限访问此图片模型" } });
    const encoded = btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join(""));
    expect(new UpstreamHttpError(403, text).message).toBe("上游服务返回 HTTP 403：没有权限访问此图片模型");
    expect(new UpstreamHttpError(403, encoded, "base64").message).toBe("上游服务返回 HTTP 403：没有权限访问此图片模型");
    expect(new UpstreamHttpError(400, JSON.stringify({ message: "长错误 ".repeat(1000) })).message.length).toBeLessThan(200);
    expect(new UpstreamHttpError(403, "invalid-base64", "base64").message).toBe("上游服务返回 HTTP 403：请求被拒绝");
  });

  it("keeps image downloads at their existing deadline and allows a longer review request", async () => {
    const timeouts: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
      timeouts.push(JSON.parse(options.body as string).timeout);
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: "{}" } }) };
    }));
    await proxyRequest("https://example.com/image.png", "GET");
    await proxyRequest("https://model.example/messages", "POST", {}, {}, "text", 300000);
    expect(timeouts).toEqual([60000, 300000]);
  });

  it("recognizes the timeout reported by the SiYuan kernel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 1, msg: "context deadline exceeded (Client.Timeout exceeded while awaiting headers)", data: null }) })));
    await expect(proxyRequest("https://model.example", "POST")).rejects.toBeInstanceOf(ProxyTimeoutError);
  });

  it("recognizes an earlier gateway timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 504, body: "Gateway Timeout" } }) })));
    await expect(proxyRequest("https://model.example", "POST", {}, {}, "text", 300000)).rejects.toBeInstanceOf(ProxyTimeoutError);
  });

  it("aborts a stalled local connection and releases its timer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_path: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const request = proxyRequest("https://model.example", "POST", {}, {}, "text", 300000);
    const assertion = expect(request).rejects.toBeInstanceOf(ProxyTimeoutError);
    await vi.advanceTimersByTimeAsync(305000); await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a fallback request without reporting a timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController(); let requestSignal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((_path: string, options: RequestInit) => new Promise((_resolve, reject) => {
      requestSignal = options.signal as AbortSignal;
      requestSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const request = proxyRequest("https://model.example", "POST", {}, {}, "text", 300000, controller.signal);
    const assertion = expect(request).rejects.toBeInstanceOf(RequestCancelledError);
    controller.abort(); await assertion;
    expect(requestSignal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
});

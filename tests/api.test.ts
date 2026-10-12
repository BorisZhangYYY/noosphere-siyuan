/** 思源代理的超时、错误分类和浏览器连接截止时间验证。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyRequest, ProxyTimeoutError } from "../src/siyuan/api";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("SiYuan proxy timeout", () => {
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
});

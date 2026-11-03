import { afterEach, expect, it, vi } from "vitest";
import { downloadRemoteImage, ImageUnavailableError } from "../src/images/download";
import { ProxyTimeoutError, RequestCancelledError } from "../src/siyuan/api";

afterEach(() => vi.unstubAllGlobals());

/** 模拟思源内核转发：按主机返回状态，记录实际请求地址。 */
function mockProxy(statuses: Record<string, number>) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    urls.push(request.url);
    const status = statuses[new URL(request.url).host] ?? 200;
    return { ok: true, json: async () => ({ code: 0, data: { status, body: "aGVsbG8=", contentType: "image/png" } }) };
  }));
  return urls;
}

it("retries a blocked zhihu CDN host on its mirrors with the same path", async () => {
  const urls = mockProxy({ "pic-out.zhimg.com": 403 });
  const result = await downloadRemoteImage("https://pic-out.zhimg.com/v2-abc~resize:1440:q75.png?scene=editor");
  expect(result.body).toBe("aGVsbG8=");
  expect(urls).toHaveLength(2);
  expect(urls[1]).toBe("https://picx.zhimg.com/v2-abc~resize:1440:q75.png?scene=editor");
});

it("keeps a non-CDN blocked image as unavailable without extra requests", async () => {
  const urls = mockProxy({ "example.com": 403 });
  await expect(downloadRemoteImage("https://example.com/pic.png")).rejects.toBeInstanceOf(ImageUnavailableError);
  expect(urls).toEqual(["https://example.com/pic.png"]);
});

it("reports unavailable when every mirror refuses the image", async () => {
  const urls = mockProxy({ "pic-out.zhimg.com": 403, "picx.zhimg.com": 403, "pica.zhimg.com": 403, "pic1.zhimg.com": 403 });
  await expect(downloadRemoteImage("https://pic-out.zhimg.com/v2-abc.png")).rejects.toBeInstanceOf(ImageUnavailableError);
  expect(urls).toHaveLength(4);
});

it("does not mask a timeout by switching to a mirror", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
    urls.push(JSON.parse(options.body as string).url);
    throw new Error("request timeout");
  }));
  await expect(downloadRemoteImage("https://pic-out.zhimg.com/v2-abc.png")).rejects.toBeInstanceOf(ProxyTimeoutError);
  expect(urls).toHaveLength(1);
});

it("keeps cancellation visible instead of retrying a mirror", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn((_path: string, options: RequestInit) => new Promise((_resolve, reject) => {
    urls.push(JSON.parse(options.body as string).url);
    options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  })));
  const controller = new AbortController();
  const pending = downloadRemoteImage("https://pic-out.zhimg.com/v2-abc.png", controller.signal);
  const assertion = expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
  await vi.waitFor(() => expect(urls).toHaveLength(1));
  controller.abort();
  await assertion;
  expect(urls).toHaveLength(1);
});

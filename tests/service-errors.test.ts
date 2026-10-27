/** 明确失败在 HTTP、业务信封和流式事件中统一阻断，正常内容不能掩盖错误。 */
import { afterEach, expect, it, vi } from "vitest";
import { ServiceResponseError, throwIfServiceError } from "../src/siyuan/errors";
import { proxyRequest } from "../src/siyuan/api";
import { reviewArticleDetailed } from "../src/review/provider";
import { reviewImages } from "../src/review/images";
import { requestShortText } from "../src/review/short-request";
import { DEFAULT_SETTINGS, type Settings } from "../src/types";

const article = { url: "https://example.com/post", title: "原文", markdown: "保留的正文" };
const resultText = JSON.stringify({ title: "审阅稿", markdown: "新正文", summary: "摘要" });
const settings = (format: Settings["modelFormat"] = "openai_chat"): Settings => ({ ...DEFAULT_SETTINGS, modelFormat: format, modelBaseUrl: "https://model.example", modelKey: "test", modelName: "test", modelVisionCapable: true });
const envelope = (body: unknown, status = 200): object => ({ ok: true, json: async () => ({ code: 0, data: { status, body: JSON.stringify(body), contentType: "application/json" } }) });
const validResult = (format: Settings["modelFormat"]): object => format === "anthropic" ? { content: [{ type: "text", text: resultText }] }
  : format === "openai_responses" ? { output_text: resultText }
    : format === "google" ? { candidates: [{ content: { parts: [{ text: resultText }] } }] }
      : { choices: [{ message: { content: resultText } }] };
afterEach(() => vi.unstubAllGlobals());

const failures: Array<[Record<string, unknown>, string | number]> = [
  [{ code: -7, message: "供应商失败" }, -7],
  [{ code: "ACCOUNT_BLOCKED", message: "供应商失败" }, "ACCOUNT_BLOCKED"],
  [{ error_code: 1001, message: "供应商失败" }, 1001],
  [{ error: 1002, message: "供应商失败" }, 1002],
  [{ error: { code: "permission_denied", message: "供应商失败" } }, "permission_denied"],
  [{ base_resp: { status_code: 1008, status_msg: "供应商失败" } }, 1008],
  [{ response: { status: "failed", error: { code: "server_error", message: "供应商失败" } } }, "server_error"],
];
it.each(failures)("recognizes a failed service envelope %j", (payload, code) => {
  try { throwIfServiceError(payload); throw new Error("expected a service failure"); }
  catch (error) { expect(error).toBeInstanceOf(ServiceResponseError); expect(error).toMatchObject({ code, message: expect.stringContaining("供应商失败") }); }
});
it.each([{ success: false }, { ok: false }, { status: false }, { status: "failed" }, { statusCode: 503 }, { type: "error", message: "bad request" }, { error: "service failed" }])("rejects explicit failure without relying on HTTP 429: %j", payload => {
  expect(() => throwIfServiceError(payload)).toThrow(ServiceResponseError);
});
it.each([{ code: 0 }, { code: "0" }, { code: 200 }, { status: 201 }, { status: "in_progress" }, { status: "completed", error: null }, { choices: [{ message: { content: '{"error":"quoted article content"}' } }] }])("does not mistake successful envelopes or article content for errors: %j", payload => {
  expect(() => throwIfServiceError(payload)).not.toThrow();
});
it.each([400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504, 599])("preserves HTTP %i and never retries it", async status => {
  vi.stubGlobal("fetch", vi.fn(async () => envelope({ message: "service failure" }, status)));
  await expect(proxyRequest("https://model.example", "POST")).rejects.toMatchObject({ code: status, status });
  expect(fetch).toHaveBeenCalledOnce();
});
it.each(["openai_chat", "openai_responses", "anthropic", "google"] as const)("rejects errors before using apparently valid %s content", async format => {
  for (const [payload, code] of failures) {
    vi.stubGlobal("fetch", vi.fn(async () => envelope({ ...validResult(format), ...payload })));
    const accept = vi.fn();
    await expect(reviewArticleDetailed(article, settings(format), article.markdown, { onTextReviewed: accept })).rejects.toMatchObject({ code });
    expect(accept).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
    expect(article.markdown).toBe("保留的正文");
  }
});
it("short requests reject a business code even alongside normal content", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => envelope({ ...validResult("openai_chat"), code: "MODEL_DISABLED", message: "供应商失败" })));
  await expect(requestShortText(settings(), "分类", "正文")).rejects.toMatchObject({ code: "MODEL_DISABLED" });
  expect(fetch).toHaveBeenCalledOnce();
});
it.each(failures)("rejects a coded streaming event %j without accepting partial text", async (payload, code) => {
  const prefix = { choices: [{ delta: { content: resultText } }] };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(`data: ${JSON.stringify(prefix)}\n\ndata: ${JSON.stringify(payload)}\n\n`)));
  const accept = vi.fn();
  await expect(reviewArticleDetailed(article, settings(), article.markdown, { onTextDelta: vi.fn(), onTextReviewed: accept })).rejects.toMatchObject({ code });
  expect(accept).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
});
it("exits on HTTP status without waiting for an error body that never finishes", async () => {
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 503 })));
  await expect(reviewArticleDetailed(article, settings(), article.markdown, { onTextDelta: vi.fn() })).rejects.toMatchObject({ code: 503 });
  expect(cancel).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
});
it.each(failures)("image review does not retry a business error %j as malformed recognition", async (payload, code) => {
  vi.stubGlobal("fetch", vi.fn(async (_path, options: RequestInit) => JSON.parse(options.body as string).method === "GET"
    ? { ok: true, json: async () => ({ code: 0, data: { status: 200, body: "aGVsbG8=", contentType: "image/png" } }) }
    : envelope({ ...validResult("openai_chat"), ...payload })));
  const source = { ...article, markdown: "![图](https://example.com/photo.png)" };
  await expect(reviewImages(source, "摘要", settings())).rejects.toMatchObject({ code });
  expect(fetch).toHaveBeenCalledTimes(2);
});

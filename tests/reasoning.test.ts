/** 按官方供应商示例验证思考/正文分离、状态切换及只有生成进展才续期。 */
import { afterEach, expect, it, vi } from "vitest";
import { reviewArticleDetailed } from "../src/review/provider";
import { ModelReviewStream } from "../src/review/stream";
import { chatResponseContent, reasoningRequestOptions } from "../src/review/reasoning";
import { requestShortText } from "../src/review/short-request";
import { reviewImages } from "../src/review/images";
import { DEFAULT_SETTINGS, type Settings } from "../src/types";

const article = { url: "https://example.com/post", title: "原文", markdown: "保留的原文" };
const output = JSON.stringify({ title: "审阅稿", markdown: "完成的正文与示例 <think>标签</think>", summary: "摘要" });
const event = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;
const settings = (modelBaseUrl: string, modelFormat: Settings["modelFormat"] = "openai_chat"): Settings => ({ ...DEFAULT_SETTINGS, modelBaseUrl, modelFormat, modelKey: "test", modelName: "test", modelVisionCapable: true });
const response = (content: string): Response => new Response(JSON.stringify({ code: 0, data: { status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content } }] }) } }));
const fixtures: Array<[string, Settings, unknown]> = [
  ["MiniMax 国内", settings("https://api.minimax.cn/v1"), { choices: [{ delta: { reasoning_content: "公开思考片段" } }] }],
  ["MiniMax 旧域名", settings("https://api.minimaxi.com/v1"), { choices: [{ delta: { reasoning_content: "公开思考片段" } }] }],
  ["Kimi Code Chat", settings("https://api.kimi.com/coding/v1"), { choices: [{ delta: { reasoning_content: "公开思考片段" } }] }],
  ["Kimi Code Messages", settings("https://api.kimi.com/coding/", "anthropic"), { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "公开思考片段" } }],
  ["Kimi Code Responses", settings("https://api.kimi.com/coding/v1", "openai_responses"), { type: "response.reasoning_summary_text.delta", delta: "公开思考片段" }],
  ["DeepSeek Chat", settings("https://api.deepseek.com/v1"), { choices: [{ delta: { reasoning_content: "公开思考片段" } }] }],
  ["DeepSeek Responses", settings("https://api.deepseek.com/v1", "openai_responses"), { type: "response.reasoning_text.delta", delta: "公开思考片段" }],
];
function finish(format: Settings["modelFormat"]): string {
  return format === "anthropic" ? event({ type: "content_block_delta", delta: { type: "text_delta", text: output } }) + event({ type: "message_stop" })
    : format === "openai_responses" ? event({ type: "response.output_text.delta", delta: output }) + event({ type: "response.completed" })
      : event({ choices: [{ delta: { content: output }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(fixtures)("keeps %s thinking alive beyond ten minutes without accepting it as body", async (_label, config, thinking) => {
  vi.useFakeTimers(); let stream!: ReadableStreamDefaultController<Uint8Array>, signal!: AbortSignal;
  vi.stubGlobal("fetch", vi.fn(async (_path, options: RequestInit) => {
    signal = options.signal as AbortSignal;
    expect(JSON.parse(options.body as string).reasoning_split).toBe(config.modelBaseUrl.includes("minimax") ? true : undefined);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
  }));
  const activity = vi.fn(), content = vi.fn(), accepted = vi.fn();
  const pending = reviewArticleDetailed(article, config, article.markdown, { onTextDelta: content, onModelActivity: activity, onTextReviewed: accepted });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 12; i++) {
    await vi.advanceTimersByTimeAsync(60000);
    stream.enqueue(new TextEncoder().encode(event(thinking))); await vi.advanceTimersByTimeAsync(0);
  }
  expect(activity).toHaveBeenLastCalledWith("thinking"); expect(signal.aborted).toBe(false);
  expect(content).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled();
  stream.enqueue(new TextEncoder().encode(finish(config.modelFormat))); stream.close();
  expect((await pending).markdown).toContain("完成的正文");
  expect(content).toHaveBeenLastCalledWith(output); expect(activity).toHaveBeenCalledWith("text");
  expect(vi.getTimerCount()).toBe(0); expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  ": heartbeat\n\n",
  event({ choices: [{ delta: { reasoning_content: "", content: "" } }] }),
  event({ type: "content_block_delta", delta: { type: "signature_delta", signature: "opaque signature" } }),
])("does not renew generation deadlines for heartbeats, empty deltas or signatures: %s", async frame => {
  vi.useFakeTimers(); let stream!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }))));
  const accepted = vi.fn(), pending = reviewArticleDetailed(article, settings("https://api.kimi.com/coding/", "anthropic"), article.markdown, { onTextDelta: vi.fn(), onTextReviewed: accepted });
  const assertion = expect(pending).rejects.toThrow("未收到生成进展");
  await vi.advanceTimersByTimeAsync(0);
  // 第一分钟有真实思考，此后持续收到连接活动，仍必须在思考停止十分钟后退出。
  await vi.advanceTimersByTimeAsync(60000);
  stream.enqueue(new TextEncoder().encode(event({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "有效思考" } })));
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 9; i++) {
    await vi.advanceTimersByTimeAsync(60000); stream.enqueue(new TextEncoder().encode(frame)); await vi.advanceTimersByTimeAsync(0);
  }
  await vi.advanceTimersByTimeAsync(60000); await assertion;
  expect(accepted).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("separates byte-split MiniMax think prefixes without removing same-named tags inside article JSON", () => {
  const content = vi.fn(), activity = vi.fn(), stream = new ModelReviewStream("openai_chat", content, activity);
  for (const char of ` \n<think>第一段思考</think>\n<think>第二段思考</think>\n${output}`) {
    stream.parser.push(event({ choices: [{ delta: { content: char } }] }));
  }
  stream.parser.push("data: [DONE]\n\n");
  expect(stream.finish()!.trim()).toBe(output);
  expect(content.mock.calls.some(([body]) => body.includes("第一段思考"))).toBe(false);
  expect(activity).toHaveBeenCalledWith("thinking"); expect(activity).toHaveBeenCalledWith("text");
});

it("does not label a heartbeat or reasoning block announcement as generated text", () => {
  const activity = vi.fn(), content = vi.fn(), stream = new ModelReviewStream("anthropic", content, activity);
  stream.parser.push(": ping\n\n"); expect(activity).toHaveBeenLastCalledWith("heartbeat");
  stream.parser.push(event({ type: "content_block_start", content_block: { type: "thinking", thinking: "" } }));
  expect(activity).toHaveBeenLastCalledWith("thinking"); expect(stream.progressVersion).toBe(0);
  stream.parser.push(event({ type: "content_block_delta", delta: { type: "signature_delta", signature: "signature" } }));
  expect(stream.progressVersion).toBe(0); expect(content).not.toHaveBeenCalled();
});

it("recognizes compatible reasoning fields without merging them into article output", () => {
  for (const delta of [{ reasoning: "思考" }, { reasoning_details: [{ type: "reasoning.text", text: "思考" }] }]) {
    const activity = vi.fn(), content = vi.fn(), stream = new ModelReviewStream("openai_chat", content, activity);
    stream.parser.push(event({ choices: [{ delta }] }));
    expect(activity).toHaveBeenLastCalledWith("thinking"); expect(stream.progressVersion).toBe(1); expect(content).not.toHaveBeenCalled();
  }
});

it("rejects unfinished tagged thinking instead of treating its JSON as an article", () => {
  expect(() => chatResponseContent('<think>{"title":"这仍是思考中的 JSON"}')).toThrow("思考输出未完成");
  expect(chatResponseContent(`<think>思考</think>${output}`)).toBe(output);
});

it("applies MiniMax reasoning separation to normal, short and image requests without altering other suppliers", async () => {
  const config = settings("https://api.minimax.cn/v1");
  for (const url of ["https://api.minimaxi.com/v1", "https://api.minimax.cn/v1", "https://api.minimax.io/v1", "https://api.minimax.chat/v1"]) expect(reasoningRequestOptions(settings(url))).toEqual({ reasoning_split: true });
  expect(reasoningRequestOptions(settings("https://api.minimax.cn.evil.example/v1"))).toEqual({});
  expect(reasoningRequestOptions({ ...config, modelFormat: "anthropic" })).toEqual({});
  const fetchMock = vi.fn(async (_path, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    if (request.method === "GET") return new Response(JSON.stringify({ code: 0, data: { status: 200, contentType: "image/png", body: "aGVsbG8=" } }));
    expect(request.payload.reasoning_split).toBe(true);
    return response(`<think>独立思考</think>${request.payload.temperature === 0 ? '{"classification":"RELEVANT","description":"配图"}' : output}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  expect((await reviewArticleDetailed(article, config)).markdown).toContain("完成的正文");
  expect(await requestShortText(config, "分类", "正文")).toBe(output);
  expect((await reviewImages({ ...article, markdown: "![图](https://example.com/photo.png)" }, "摘要", config)).reviewed).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(4);
});

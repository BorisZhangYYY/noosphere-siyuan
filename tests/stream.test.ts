/** 真实 ReadableStream 替身覆盖四种协议、UTF-8 分包、截断与安全降级。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewArticleDetailed } from "../src/review/provider";
import { EventStreamParser, partialReviewContent } from "../src/review/stream";
import { DEFAULT_SETTINGS, type Settings } from "../src/types";
import { proxyStreamRequest, ProxyTimeoutError, RequestCancelledError } from "../src/siyuan/api";

const article = { url: "https://example.com/post", title: "原文", markdown: "原始正文" };
const output = JSON.stringify({ title: "审阅稿", markdown: "## 正文\n\n中文 😀 与引号\"、反斜线\\", summary: "内部摘要" });
const event = (value: unknown, name?: string): string => `${name ? `event: ${name}\r\n` : ""}data: ${JSON.stringify(value)}\r\n\r\n`;
const settings = (format: Settings["modelFormat"]): Settings => ({ ...DEFAULT_SETTINGS, modelFormat: format, modelBaseUrl: "https://model.example", modelKey: "test", modelName: "test" });

/** 每个字节单独送达，刻意把中文、表情和 SSE 分隔符拆开。 */
function streamed(body: string): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }), { headers: { "Siyuan-Proxy-Content-Type": "text/event-stream" } });
}

function protocol(format: Settings["modelFormat"], stop = ""): string {
  const parts = [output.slice(0, 18), output.slice(18, 51), output.slice(51)];
  if (format === "anthropic") return event({ type: "ping" })
    + event({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "隐藏思考" } })
    + parts.map(text => event({ type: "content_block_delta", delta: { type: "text_delta", text } })).join("")
    + event({ type: "message_delta", delta: { stop_reason: stop || "end_turn" } }) + event({ type: "message_stop" });
  if (format === "openai_responses") return parts.map(delta => event({ type: "response.output_text.delta", delta })).join("")
    + event(stop ? { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: stop } } } : { type: "response.completed", response: { status: "completed" } });
  if (format === "google") return parts.map(text => event({ candidates: [{ content: { parts: [{ thought: true, text: "隐藏思考" }, { text }] } }] })).join("")
    + event({ candidates: [{ finishReason: stop || "STOP" }] });
  return parts.map(content => event({ choices: [{ index: 0, delta: { content } }] })).join("")
    + event({ choices: [{ index: 0, finish_reason: stop || "stop", delta: {} }] }) + "data: [DONE]\r\n\r\n";
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("streaming article review", () => {
  it.each(["openai_chat", "openai_responses", "anthropic", "google"] as const)("decodes byte-split %s and accepts only the complete JSON", async format => {
    const updates: string[] = [], accept = vi.fn();
    const fetchMock = vi.fn(async (path: string, options: RequestInit) => {
      const url = new URL(path, "http://localhost");
      expect(url.pathname).toBe("/api/network/proxy");
      const target = Buffer.from(url.searchParams.get("u")!, "base64url").toString();
      const headers = JSON.parse(Buffer.from(url.searchParams.get("h")!, "base64url").toString());
      expect(headers.Accept).toEqual(["text/event-stream"]);
      const payload = JSON.parse(options.body as string);
      const prompt = format === "google" ? payload.systemInstruction.parts[0].text : format === "anthropic" ? payload.system : format === "openai_responses" ? payload.instructions : payload.messages[0].content;
      expect(prompt).toContain("全部使用英文（English）");
      if (format === "google") expect(target).toContain(":streamGenerateContent?alt=sse");
      else expect(payload.stream).toBe(true);
      return streamed(protocol(format));
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await reviewArticleDetailed(article, { ...settings(format), outputLanguage: "en-US" }, article.markdown, { onTextDelta: value => updates.push(value), onTextReviewed: accept });
    expect(updates).toHaveLength(3);
    expect(updates.at(-1)).toBe(output);
    expect(result.markdown).toContain("中文 😀 与引号\"、反斜线\\");
    expect(result.markdown).not.toContain("隐藏思考");
    expect(accept).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("delivers output before completion while retaining the source until validation", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }))));
    const onTextDelta = vi.fn(), onTextReviewed = vi.fn();
    const pending = reviewArticleDetailed(article, settings("openai_chat"), article.markdown, { onTextDelta, onTextReviewed });
    await vi.waitFor(() => expect(stream).toBeDefined());
    stream.enqueue(new TextEncoder().encode(event({ choices: [{ delta: { content: output } }] })));
    await vi.waitFor(() => expect(onTextDelta).toHaveBeenCalledWith(output));
    expect(onTextReviewed).not.toHaveBeenCalled(); expect(article.markdown).toBe("原始正文");
    stream.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); stream.close();
    expect((await pending).markdown).toContain("## 正文"); expect(onTextReviewed).toHaveBeenCalledOnce();
  });

  it.each([["anthropic", "max_tokens"], ["openai_chat", "length"], ["openai_responses", "max_output_tokens"], ["google", "MAX_TOKENS"]] as const)("rejects %s output cut off by %s", async (format, stop) => {
    vi.stubGlobal("fetch", vi.fn(async () => streamed(protocol(format, stop))));
    const accept = vi.fn();
    await expect(reviewArticleDetailed(article, settings(format), article.markdown, { onTextDelta: vi.fn(), onTextReviewed: accept })).rejects.toThrow("被截断");
    expect(accept).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a missing completion event even when the generated JSON is valid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamed(event({ choices: [{ delta: { content: output } }] }))));
    await expect(reviewArticleDetailed(article, settings("openai_chat"), article.markdown, { onTextDelta: vi.fn() })).rejects.toThrow("连接已中断");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not retry a mid-stream provider error and cancels its reader", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(event({ error: { message: "Overloaded" } }, "error")));
    }, cancel }))));
    await expect(reviewArticleDetailed(article, settings("anthropic"), article.markdown, { onTextDelta: vi.fn() })).rejects.toThrow("Overloaded");
    expect(fetch).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("falls back only when the SiYuan streaming route is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("missing route", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: output } }] }) } })));
    vi.stubGlobal("fetch", fetchMock);
    const fallback = vi.fn();
    expect((await reviewArticleDetailed(article, settings("openai_chat"), article.markdown, { onTextDelta: vi.fn(), onStreamFallback: fallback })).markdown).toContain("## 正文");
    expect(fallback).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).payload.stream).toBeUndefined();
  });

  it("does not retry a supplier's 404 or a rate limit", async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"model missing"}}', { status: 404, headers: { "Siyuan-Proxy-Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reviewArticleDetailed(article, settings("openai_chat"), article.markdown, { onTextDelta: vi.fn() })).rejects.toMatchObject({ code: 404 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts a service that ignores streaming without issuing another model request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: output } }] }))));
    expect((await reviewArticleDetailed(article, settings("openai_chat"), article.markdown, { onTextDelta: vi.fn() })).markdown).toContain("## 正文");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("aborts a silent connection at ninety seconds and releases both timers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_path: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const request = proxyStreamRequest("https://model.example", {}, {}, vi.fn());
    const assertion = expect(request).rejects.toBeInstanceOf(ProxyTimeoutError);
    await vi.advanceTimersByTimeAsync(90000); await assertion; expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a stalled stream without waiting for its unresponsive cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode("first")); },
      cancel() { return new Promise(() => undefined); },
    }))));
    const progress = vi.fn(), pending = proxyStreamRequest("https://model.example", {}, {}, progress);
    const assertion = expect(pending).rejects.toMatchObject({ timeoutMs: 90000 });
    await vi.advanceTimersByTimeAsync(0); expect(progress).toHaveBeenCalledWith("first");
    await vi.advanceTimersByTimeAsync(90000); await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an active long stream alive while resetting only the idle deadline", async () => {
    vi.useFakeTimers(); let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }))));
    const pending = proxyStreamRequest("https://model.example", {}, {}, vi.fn(), 600000);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(60000);
      stream.enqueue(new TextEncoder().encode("chunk")); await vi.advanceTimersByTimeAsync(0);
    }
    stream.close(); expect(await pending).toBe("chunk".repeat(4));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["openai_chat", "openai_responses", "anthropic", "google"] as const)("keeps %s reasoning activity alive without body content", async format => {
    vi.useFakeTimers(); let stream!: ReadableStreamDefaultController<Uint8Array>, signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn(async (_path, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
    }));
    const slow = vi.fn(), content = vi.fn(), accepted = vi.fn();
    const pending = reviewArticleDetailed(article, settings(format), article.markdown, { onTextDelta: content, onSlowResponse: slow, onTextReviewed: accepted });
    await vi.advanceTimersByTimeAsync(0);
    const thinking = format === "anthropic" ? { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "internal reasoning" } }
      : format === "openai_responses" ? { type: "response.reasoning_summary_text.delta", delta: "internal reasoning" }
        : format === "google" ? { candidates: [{ content: { parts: [{ thought: true, text: "internal reasoning" }] } }] }
          : { choices: [{ index: 0, delta: { reasoning_content: "internal reasoning" } }] };
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(60000);
      stream.enqueue(new TextEncoder().encode(event(thinking))); await vi.advanceTimersByTimeAsync(0);
    }
    expect(slow).not.toHaveBeenCalled(); expect(content).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled(); expect(signal.aborted).toBe(false);
    stream.enqueue(new TextEncoder().encode(protocol(format))); stream.close();
    expect((await pending).markdown).toContain("## 正文"); expect(accepted).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("warns after silence without aborting a model that is still working", async () => {
    vi.useFakeTimers(); let stream!: ReadableStreamDefaultController<Uint8Array>, signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn(async (_path, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
    }));
    const slow = vi.fn(), content = vi.fn();
    const pending = reviewArticleDetailed(article, settings("anthropic"), article.markdown, { onTextDelta: content, onSlowResponse: slow });
    await vi.advanceTimersByTimeAsync(180000);
    expect(slow).toHaveBeenCalledOnce(); expect(signal.aborted).toBe(false); expect(content).not.toHaveBeenCalled();
    stream.enqueue(new TextEncoder().encode(protocol("anthropic"))); stream.close();
    expect((await pending).markdown).toContain("## 正文"); expect(vi.getTimerCount()).toBe(0);
  });

  it("also allows reasoning activity when no slow-response callback was supplied", async () => {
    vi.useFakeTimers(); let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }))));
    const pending = reviewArticleDetailed(article, settings("openai_chat"), article.markdown, { onTextDelta: vi.fn() });
    await vi.advanceTimersByTimeAsync(120000);
    stream.enqueue(new TextEncoder().encode(protocol("openai_chat"))); stream.close();
    expect((await pending).markdown).toContain("## 正文");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a deadline when only heartbeats arrive without generation progress", async () => {
    vi.useFakeTimers(); let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }))));
    const pending = reviewArticleDetailed(article, settings("openai_chat"), article.markdown, { onTextDelta: vi.fn() });
    const assertion = expect(pending).rejects.toThrow("审阅请求超时");
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(60000);
      stream.enqueue(new TextEncoder().encode(": heartbeat\n\n")); await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(60000); await assertion; expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("allows a delayed non-streaming response after the warning (fallback=%s)", async fallback => {
    vi.useFakeTimers(); let finish!: (response: Response) => void, signal!: AbortSignal;
    const fetchMock = vi.fn((_path, options: RequestInit) => {
      if (fallback && fetchMock.mock.calls.length === 1) return Promise.resolve(new Response("missing", { status: 404 }));
      signal = options.signal as AbortSignal;
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const slow = vi.fn(), accept = vi.fn();
    const pending = reviewArticleDetailed(article, settings("openai_chat"), article.markdown, { onSlowResponse: slow, onTextReviewed: accept, ...(fallback ? { onTextDelta: vi.fn() } : {}) });
    await vi.advanceTimersByTimeAsync(180000);
    expect(slow).toHaveBeenCalledOnce(); expect(signal.aborted).toBe(false); expect(accept).not.toHaveBeenCalled();
    finish(new Response(JSON.stringify({ code: 0, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: output } }] }) } })));
    expect((await pending).markdown).toContain("## 正文"); expect(accept).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops an in-progress stream on user cancellation without accepting partial text", async () => {
    const controller = new AbortController(); let requestSignal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
      requestSignal = options.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ start(stream) {
        stream.enqueue(new TextEncoder().encode(event({ choices: [{ delta: { content: output } }] })));
        requestSignal.addEventListener("abort", () => stream.error(new DOMException("Aborted", "AbortError")));
      } }));
    }));
    const updates = vi.fn(), accept = vi.fn();
    const pending = reviewArticleDetailed(article, settings("openai_chat"), article.markdown, { onTextDelta: updates, onTextReviewed: accept, signal: controller.signal });
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
    await vi.waitFor(() => expect(updates).toHaveBeenCalled()); controller.abort(); await assertion;
    expect(requestSignal.aborted).toBe(true); expect(accept).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not start a model request when cancelled before review", async () => {
    const controller = new AbortController(); controller.abort(); vi.stubGlobal("fetch", vi.fn());
    await expect(reviewArticleDetailed(article, settings("anthropic"), article.markdown, { signal: controller.signal })).rejects.toBeInstanceOf(RequestCancelledError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("stream preview parsing", () => {
  it("decodes partial strings without leaking summary, JSON or unfinished escapes", () => {
    expect(partialReviewContent('{"title":"新标题","markdown":"段落\\n中文\\u4e')).toEqual({ title: "新标题", markdown: "段落\n中文" });
    expect(partialReviewContent(output).markdown).toBe(JSON.parse(output).markdown);
    expect(partialReviewContent('{"summary":"内部摘要","metadata_candidates":{"markdown":"假正文"},"markdown":"正文')).toEqual({ title: "", markdown: "正文" });
    expect(partialReviewContent('{"markdown":"\\ud83d')).toEqual({ title: "", markdown: "" });
    expect(partialReviewContent('{"markdown":"\\ud83d\\ude00')).toEqual({ title: "", markdown: "😀" });
  });

  it("detects the end of the actual body before the model finishes its internal summary", () => {
    const complete = vi.fn();
    partialReviewContent('{"markdown":"正在生成', complete); expect(complete).not.toHaveBeenCalled();
    expect(partialReviewContent('{"markdown":"完整正文","summary":"内部还在生成', complete).markdown).toBe("完整正文");
    expect(complete).toHaveBeenCalledOnce();
    const nested = vi.fn(); partialReviewContent('{"metadata_candidates":{"markdown":"非正文"}}', nested);
    expect(nested).not.toHaveBeenCalled();
  });

  it("supports comments, multiple data lines and a final frame without a separator", () => {
    const accept = vi.fn(), parser = new EventStreamParser(accept);
    parser.push(": ping\n\nevent: update\ndata: first\ndata: second\n\n");
    parser.push("data: last", true);
    expect(accept.mock.calls.map(([value]) => value)).toEqual([{ event: "update", data: "first\nsecond" }, { event: "message", data: "last" }]);
  });
});

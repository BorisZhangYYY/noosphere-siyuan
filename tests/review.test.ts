import { afterEach, describe, expect, it, vi } from "vitest";
import { listAvailableModels, modelEndpoint, reviewArticle } from "../src/review/provider";
import { DEFAULT_SETTINGS, type Article } from "../src/types";
import { buildReviewPrompt, migratePerspective, parseReviewResult, renderReview, validatePerspective } from "../src/review/perspectives";
import { composeArticle } from "../src/article/compose";

const article: Article = { url: "https://example.com/post", title: "Article", markdown: "# Article\nBody" };
const originalResponse = JSON.stringify({ title: "Reviewed article", markdown: "## AI 摘要\n\nSummary\n\n## 正文\n\nBody", summary: "Article about Body", metadata_candidates: { author: null, published_at: null } });
const noviceResponse = JSON.stringify({ title: "Reviewed article", markdown: "## 阅读前准备\n\nBackground\n\n## 正文与讲解\n\nBody", summary: "Article about Body" });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("model review adapters", () => {
  it("allows a long Kimi Code review to finish after thirty minutes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      expect(request.timeout).toBe(3600000);
      expect(request.payload.max_tokens).toBe(32768);
      await new Promise(resolve => setTimeout(resolve, 1801000));
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: originalResponse }] }) } }) };
    }));
    const source = { ...article, markdown: "正文".repeat(12000) };
    let finished = false;
    const review = reviewArticle(source, { ...DEFAULT_SETTINGS, activeProvider: "kimi_code", modelFormat: "anthropic", modelBaseUrl: "https://api.kimi.com/coding/", modelName: "kimi-for-coding", modelKey: "test" }).then(result => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(1800000); expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); expect(await review).toContain("## 正文");
  });

  it.each(["anthropic", "openai_chat", "openai_responses", "google"] as const)("rejects an explicitly truncated %s response before accepting its JSON", async modelFormat => {
    const result = modelFormat === "anthropic" ? { stop_reason: "max_tokens", content: [{ type: "text", text: originalResponse }] }
      : modelFormat === "openai_chat" ? { choices: [{ finish_reason: "length", message: { content: originalResponse } }] }
      : modelFormat === "openai_responses" ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: originalResponse }
      : { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: originalResponse }] } }] };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify(result) } }) })));
    await expect(reviewArticle(article, { ...DEFAULT_SETTINGS, modelFormat, modelName: "test", modelKey: "test", modelBaseUrl: "https://model.example" })).rejects.toThrow("审阅结果被截断");
    expect(article.markdown).toBe("# Article\nBody");
  });

  it("explains a model timeout without labelling it as truncated output", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 1, msg: "API timeout", data: null }) })));
    await expect(reviewArticle(article, { ...DEFAULT_SETTINGS, modelFormat: "anthropic", modelBaseUrl: "https://api.kimi.com/coding/", modelName: "kimi-for-coding", modelKey: "test" })).rejects.toThrow("审阅请求超时");
  });

  it("accepts free-form article structure without slot variables or a visible summary", () => {
    const custom = { id: "custom_notes", label: "论证笔记", description: "突出论据", prompt: "逐条检查论据", template: "不要摘要。按 ## 要点 1、## 要点 2 展开，最后写 ## 总结。" };
    const settings = { ...DEFAULT_SETTINGS, reviewPerspective: custom.id, customPerspectives: [custom] };
    expect(validatePerspective(custom)).toBeUndefined();
    expect(buildReviewPrompt(settings)).toContain("不要摘要");
    const output = renderReview(JSON.stringify({ title: "新标题", markdown: "## 要点 1\n证据\n\n## 要点 2\n引用\n\n## 总结\n结论", summary: "只用于图片审阅" }), article, settings);
    expect(output).toContain("## 要点 1\n证据");
    expect(output).toContain("## 总结\n结论");
    expect(output).not.toContain("只用于图片审阅");
    expect(composeArticle(article, output).match(/来源：/g)).toHaveLength(1);
    expect(() => renderReview('{"title":"新标题","markdown":""}', article, settings)).toThrow("缺少标题或正文");
    expect(() => renderReview('{"title":"新标题","markdown":"正文"}', article, settings)).toThrow("缺少供图片判断使用的摘要");
  });

  it("accepts evidence-backed missing metadata and protects crawler values", () => {
    const source = { ...article, markdown: "# Article\n作者 张三 写于 2026年9月22日。\n正文" };
    const response = JSON.stringify({ title: "结果", markdown: "## 正文\n内容", summary: "内部摘要", metadata_candidates: { author: { value: "张三", evidence: "作者 张三 写于 2026年9月22日" }, published_at: { value: "2026-09-22", evidence: "作者 张三 写于 2026年9月22日" } } });
    const accepted = parseReviewResult(response, source, { ...DEFAULT_SETTINGS, reviewPerspective: "original" });
    expect(accepted.article.author).toBe("张三");
    expect(accepted.article.publishedAt).toBe("2026-09-22");
    expect(accepted.markdown).toContain("作者：张三");
    expect(accepted.markdown).not.toContain("内部摘要");
    const protectedValue = parseReviewResult(response, { ...source, author: "原作者" }, { ...DEFAULT_SETTINGS, reviewPerspective: "original" });
    expect(protectedValue.article.author).toBe("原作者");
    const rejected = parseReviewResult(response.replace("作者 张三 写于 2026年9月22日", "不存在的证据"), article, { ...DEFAULT_SETTINGS, reviewPerspective: "original" });
    expect(rejected.article.author).toBeUndefined();
    const invalidDate = parseReviewResult(response.replace("2026-09-22", "2026-13-22"), source, { ...DEFAULT_SETTINGS, reviewPerspective: "original" });
    expect(invalidDate.article.publishedAt).toBeUndefined();
  });

  it("migrates a saved variable template into editable natural-language guidance", () => {
    const legacy = { id: "custom", label: "旧视角", description: "", prompt: "忠实原文", template: "# {{title}}\n\n{{source_metadata}}\n\n## 正文\n\n{{main_article}}", sections: [{ id: "main_article", heading: "正文", instruction: "保留论据" }] };
    const migrated = migratePerspective(legacy);
    expect(migrated.template).toContain("保留论据");
    expect(migrated.template).not.toContain("{{");
    expect(migrated.sections).toBeUndefined();
  });

  it("uses an OpenAI Chat endpoint when the configured base has no version path", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      expect(request.url).toBe("https://model.example/v1/chat/completions");
      expect(request.headers[0].Authorization).toBe("Bearer secret");
      expect(request.payload.messages[0].content).toContain("第一次接触主题的读者视角");
      expect(request.payload.messages[0].content).toContain("## 阅读前准备");
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: noviceResponse } }] }) } }) };
    }));
    const reviewed = await reviewArticle(article, { ...DEFAULT_SETTINGS, reviewPerspective: "novice", modelBaseUrl: "https://model.example", modelKey: "secret", modelName: "model" });
    expect(reviewed).toContain("## 阅读前准备\n\nBackground");
    expect(reviewed).toContain("> 来源：<https://example.com/post>");
  });

  it("uses Anthropic Messages for an existing compatible model", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      expect(request.url).toBe("https://api.example/coding/v1/messages");
      expect(request.headers[0]).toMatchObject({ "x-api-key": "secret", "anthropic-version": "2023-06-01" });
      expect(request.payload.messages[0].content).toContain("# Article");
      expect(request.payload.system).toContain("以原作者的视角审阅");
      expect(request.payload.system).toContain("## AI 摘要");
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ content: [{ type: "text", text: originalResponse }] }) } }) };
    }));
    const reviewed = await reviewArticle(article, {
      ...DEFAULT_SETTINGS,
      reviewPerspective: "original",
      modelFormat: "anthropic",
      modelBaseUrl: "https://api.example/coding/",
      modelKey: "secret",
      modelName: "model",
    });
    expect(reviewed).toContain("## AI 摘要\n\nSummary");
  });

  it("returns the captured original without calling a model", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    expect(await reviewArticle(article, { ...DEFAULT_SETTINGS, reviewPerspective: "raw" })).toBe(article.markdown);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps supplier-specific version paths in the final endpoint", () => {
    expect(modelEndpoint("https://ark.cn-beijing.volces.com/api/v3", "/chat/completions")).toBe("https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    expect(modelEndpoint("https://open.bigmodel.cn/api/paas/v4", "/chat/completions")).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(modelEndpoint("https://api.kimi.com/coding/", "/messages", "anthropic")).toBe("https://api.kimi.com/coding/v1/messages");
  });

  it("uses OpenAI Responses and reads its output content", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      expect(request.payload.instructions).toContain("基于原文");
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ output: [{ content: [{ type: "output_text", text: originalResponse }] }] }) } }) };
    }));
    expect(await reviewArticle(article, { ...DEFAULT_SETTINGS, reviewPerspective: "original", modelFormat: "openai_responses", modelKey: "secret", modelName: "model" })).toContain("## AI 摘要");
  });

  it("uses Gemini generateContent and its key header", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
      expect(request.headers[0]["x-goog-api-key"]).toBe("secret");
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: originalResponse }] } }] }) } }) };
    }));
    expect(await reviewArticle(article, { ...DEFAULT_SETTINGS, reviewPerspective: "original", modelFormat: "google", modelBaseUrl: "https://generativelanguage.googleapis.com/v1beta", modelKey: "secret", modelName: "gemini-test" })).toContain("## 正文");
  });

  it("lists only Gemini models capable of generating content", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      expect(request.method).toBe("GET");
      expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ models: [{ name: "models/gemini-test", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding-test", supportedGenerationMethods: ["embedContent"] }] }) } }) };
    }));
    expect(await listAvailableModels({ ...DEFAULT_SETTINGS, modelFormat: "google", modelBaseUrl: "https://generativelanguage.googleapis.com/v1beta", modelKey: "secret" })).toEqual(["gemini-test"]);
  });
});

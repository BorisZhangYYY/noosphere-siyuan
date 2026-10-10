import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewArticleDetailed } from "../src/review/provider";
import { applyImageDecisions } from "../src/review/images";
import { DEFAULT_SETTINGS, type Article, type Settings } from "../src/types";

const article: Article = { url: "https://example.com/post", title: "Example", markdown: "# Example\n\nEvidence\n\n![screenshot](https://example.com/pic.png)\n\nEnd" };
const review = JSON.stringify({ title: "Example", markdown: "## 正文\n\nEvidence\n\nEnd", summary: "Evidence and a relevant screenshot" });
const settings: Settings = { ...DEFAULT_SETTINGS, reviewPerspective: "original", imageReview: true, modelVisionCapable: true, modelBaseUrl: "https://model.example", modelKey: "secret", modelName: "vision" };

afterEach(() => vi.unstubAllGlobals());

function mockReview(classification: "PROMOTION" | "RELEVANT", format: Settings["modelFormat"] = "openai_chat") {
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    requests.push(request);
    if (request.method === "GET") return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: "aGVsbG8=", contentType: "image/png" } }) };
    const isImage = JSON.stringify(request.payload).includes("aGVsbG8=");
    const value = isImage ? JSON.stringify({ classification, description: "界面截图" }) : review;
    const body = format === "anthropic" ? { content: [{ type: "text", text: value }] }
      : format === "openai_responses" ? { output: [{ content: [{ type: "output_text", text: value }] }] }
        : format === "google" ? { candidates: [{ content: { parts: [{ text: value }] } }] }
          : { choices: [{ message: { content: value } }] };
    return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify(body) } }) };
  }));
  return requests;
}

describe("image review", () => {
  it("reviews images after the text model and keeps removals reversible", async () => {
    const requests = mockReview("PROMOTION");
    const result = await reviewArticleDetailed(article, settings);
    expect(requests[0].payload.messages[1].content).toContain("Evidence");
    expect(requests[2].payload.messages[1].content[0].text).toContain("Evidence and a relevant screenshot");
    expect(result.markdown).toContain("pic.png");
    expect(result.imageDecisions[0].recommendedRemove).toBe(true);
    expect(applyImageDecisions(result.markdown, result.imageDecisions)).not.toContain("pic.png");
    result.imageDecisions[0].remove = false;
    expect(applyImageDecisions(result.markdown, result.imageDecisions)).toContain("pic.png");
    expect(requests[2].payload.messages[1].content[1].image_url.url).toContain("data:image/png;base64,aGVsbG8=");
  });

  it("restores a relevant image omitted by the text model", async () => {
    mockReview("RELEVANT");
    const result = await reviewArticleDetailed(article, settings);
    expect(result.imagesReviewed).toBe(1);
    expect(result.markdown).toContain("![screenshot](https://example.com/pic.png)");
    expect(result.markdown.indexOf("Evidence")).toBeLessThan(result.markdown.indexOf("pic.png"));
  });

  it.each(["openai_responses", "anthropic", "google"] as const)("sends image input using %s format", async format => {
    const requests = mockReview("RELEVANT", format);
    await reviewArticleDetailed(article, { ...settings, modelFormat: format });
    const imageRequest = requests[2];
    if (format === "openai_responses") expect(imageRequest.payload.input[0].content[1].image_url).toContain("data:image/png;base64,");
    if (format === "anthropic") expect(imageRequest.payload.messages[0].content[0].source.data).toBe("aGVsbG8=");
    if (format === "google") expect(imageRequest.payload.contents[0].parts[0].inlineData.mimeType).toBe("image/png");
  });

  it("preserves an image when recognition fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      if (request.method === "GET") return { ok: true, json: async () => ({ code: 0, data: { status: 502, body: "download failed" } }) };
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: review } }] }) } }) };
    }));
    const result = await reviewArticleDetailed(article, settings);
    expect(result.imageWarnings).toHaveLength(1);
    expect(result.markdown).toContain("![screenshot](https://example.com/pic.png)");
  });

  it("requires an explicit model vision capability flag", async () => {
    await expect(reviewArticleDetailed(article, { ...settings, modelVisionCapable: false })).rejects.toThrow("支持识图");
  });

  it("can use a separate provider for image review", async () => {
    const requests = mockReview("RELEVANT");
    const result = await reviewArticleDetailed(article, {
      ...settings,
      modelKey: "text-secret",
      modelVisionCapable: false,
      imageProvider: "kimi_code",
      modelProfiles: { kimi_code: { modelFormat: "openai_chat", modelBaseUrl: "https://vision.example", modelKey: "vision-secret", modelName: "vision", modelVisionCapable: true } },
    });
    expect(result.imagesReviewed).toBe(1);
    expect(requests[0].headers[0].Authorization).toBe("Bearer text-secret");
    expect(requests[2].url).toBe("https://vision.example/v1/chat/completions");
    expect(requests[2].headers[0].Authorization).toBe("Bearer vision-secret");
  });
});

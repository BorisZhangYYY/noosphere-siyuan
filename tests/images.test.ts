import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewArticleDetailed } from "../src/review/provider";
import { applyImageDecisions, imageInventory, localizeImagePreviews, normalizeImageDecisions, restoreImages, reviewImages } from "../src/review/images";
import { DEFAULT_SETTINGS, type Article, type Settings } from "../src/types";
import { RequestCancelledError } from "../src/siyuan/api";

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

it("cancels all vision workers without marking images failed or starting more requests", async () => {
  const controller = new AbortController(), progress = vi.fn();
  vi.stubGlobal("fetch", vi.fn((_path: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  })));
  const source = { ...article, markdown: Array.from({ length: 5 }, (_, i) => `![${i}](https://example.com/${i}.png)`).join("\n") };
  const pending = reviewImages(source, "摘要", settings, progress, controller.signal);
  const assertion = expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); controller.abort(); await assertion;
  expect(fetch).toHaveBeenCalledTimes(2); expect(progress).toHaveBeenCalledOnce(); expect(progress.mock.calls[0][0].warnings).toEqual([]);
});

describe("image review", () => {
  it("rejects an unknown image URL before accepting text or starting vision requests", async () => {
    const requests = mockReview("RELEVANT");
    const fixture = fetch;
    const invented = "https://example.com/pci.png";
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, options?: RequestInit) => {
      const request = JSON.parse(options!.body as string);
      if (request.method === "POST" && !JSON.stringify(request.payload).includes("aGVsbG8=")) {
        return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          title: "Example", markdown: `## 正文\n\nEvidence\n\n![wrong](${invented})\n\nEnd`, summary: "摘要",
        }) } }] }) } }) };
      }
      return fixture(path, options);
    }));
    const accept = vi.fn();
    await expect(reviewArticleDetailed(article, settings, article.markdown, { onTextReviewed: accept })).rejects.toThrow("受保护的链接");
    expect(accept).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(article.markdown).toContain("https://example.com/pic.png");
  });

  it("keeps valid source URLs with edited captions or relative forms, including images added to the input draft", () => {
    const source = { ...article, markdown: "Evidence\n\n![original](/pic.png)\n\n![本地](assets/local.png)" };
    const reviewed = "Evidence\n\n![new caption](https://example.com/pic.png)\n\n![本地](/assets/local.png)";
    expect(restoreImages(reviewed, source)).toBe(reviewed);
  });

  it("treats image syntax in code as examples rather than display images or restored image evidence", () => {
    const example = "![example](https://example.com/example.png)";
    const code = `\`\`\`\`md\n${example}\n\`\`\`\n${example}\n\`\`\`\`\n\n~~~md\n${example}\n~~~\n\n    ${example}\n\n\`${example}\``;
    const markdown = `${code}\n\n${article.markdown}`;
    expect(imageInventory(markdown, article.url)).toHaveLength(1);
    expect(restoreImages(code, { ...article, markdown })).toContain(code);
    expect(applyImageDecisions(markdown, [{ full: example, alt: "example", url: "https://example.com/example.png", remove: true, recommendedRemove: true, description: "移除" }])).toContain(code);
    expect(imageInventory(restoreImages(`\`${article.markdown.match(/!\[[^\]]*\]\([^)]*\)/)![0]}\``, article), article.url)).toHaveLength(1);
  });

  it("shares one decision across WeChat dimensions, tracking parameters and protocols", async () => {
    const requests = mockReview("PROMOTION");
    const source = { ...article, markdown: "![头像](http://mmbiz.qpic.cn/sz_mmbiz_png/asset/300?wx_fmt=png&wxfrom=19)\n![头像](http://mmbiz.qpic.cn/sz_mmbiz_png/asset/0?wx_fmt=png)\n![头像](https://mmbiz.qpic.cn/sz_mmbiz_png/asset/0?wx_fmt=png)" };
    const result = await reviewImages(source, "摘要", settings);
    expect(requests).toHaveLength(2); expect(result.decisions).toHaveLength(3);
    expect(result.decisions.every(item => item.remove && item.status === "reviewed")).toBe(true);
    expect(applyImageDecisions(source.markdown, result.decisions).trim()).toBe("");
  });

  it("repairs contradictory legacy duplicate suggestions and preserves explicit user choices", () => {
    const inventory = imageInventory("![头像](http://mmbiz.qpic.cn/mmbiz_png/asset/300)\n![头像](https://mmbiz.qpic.cn/mmbiz_png/asset/0)", article.url);
    const previous = inventory.map((item, i) => ({ ...item, status: "reviewed" as const, description: i ? "相关" : "装饰头像", recommendedRemove: !i, remove: !i }));
    const repaired = normalizeImageDecisions(previous, article.url);
    expect(repaired[1]).toMatchObject({ remove: true, recommendedRemove: true, description: "装饰头像" });
    expect(normalizeImageDecisions([{ ...previous[0], remove: false }, previous[1]], article.url)[0].remove).toBe(false);
  });

  it.each([true, false])("retries incomplete image responses once, with recovery=%s", async recover => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_path, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      const response = request.method === "GET" ? { status: 200, body: "aGVsbG8=", contentType: "image/png" }
        : { status: 200, body: JSON.stringify({ choices: [{ message: { content: ++attempts === 2 && recover
          ? '{"classification":"PROMOTION","description":"互动图"}' : '{"classification":' } }] }) };
      return { ok: true, json: async () => ({ code: 0, data: response }) };
    }));
    const result = await reviewImages(article, "摘要", settings);
    expect(fetch).toHaveBeenCalledTimes(3); expect(attempts).toBe(2);
    expect(result.decisions[0]).toMatchObject({ status: recover ? "reviewed" : "failed", remove: recover });
    if (!recover) expect(result.decisions[0].error).toBe("图片模型返回不完整或无效的识别结果，重试后仍未完成");
  });
  it("does not download the article page when a scraper mistakes it for an image", async () => {
    const requests = mockReview("RELEVANT");
    const source = { ...article, markdown: `![](${article.url})\n![](#article)\n${article.markdown}\n[来源](${article.url})` };
    const result = await reviewImages(source, "摘要", settings);
    expect(result.decisions).toHaveLength(1); expect(result.reviewed).toBe(1); expect(result.warnings).toEqual([]);
    expect(requests).toHaveLength(2); expect(requests[0].url).toBe("https://example.com/pic.png");
    expect(restoreImages("审阅正文", source)).not.toContain(`![](${article.url})`);
    const legacy = { full: `![](${article.url})`, alt: "", url: article.url, description: "未能识别，默认保留", status: "failed" as const, recommendedRemove: false, remove: false, error: "HTTP 403" };
    expect(normalizeImageDecisions([legacy, ...result.decisions], article.url)).toEqual(result.decisions);
  });

  it("keeps an actual blocked image with one short download failure and no model request", async () => {
    const body = btoa("<!DOCTYPE html><html>Forbidden</html>");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 403, body } }) })));
    const result = await reviewImages(article, "摘要", settings);
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.decisions[0]).toMatchObject({ status: "failed", remove: false, error: "图片下载失败：上游服务返回 HTTP 403：请求被拒绝" });
    expect(result.warnings).toEqual(["图片 1：图片下载失败：上游服务返回 HTTP 403：请求被拒绝"]);
    expect(normalizeImageDecisions([{ ...result.decisions[0], error: `上游服务返回 HTTP 403：${body}` }], article.url)[0].error).toBe("上游服务返回 HTTP 403：请求被拒绝");
  });

  it("identifies a model permission failure separately from image downloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      return { ok: true, json: async () => ({ code: 0, data: request.method === "GET"
        ? { status: 200, body: "aGVsbG8=", contentType: "image/png" }
        : { status: 403, body: JSON.stringify({ error: { message: "model permission denied" } }) } }) };
    }));
    const result = await reviewImages(article, "摘要", settings);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.decisions[0].error).toBe("图片模型请求失败：上游服务返回 HTTP 403：model permission denied");
    expect(result.decisions[0].remove).toBe(false);
  });

  it("repairs legacy local asset URLs and preserves image decisions", () => {
    const full = "![本地图](assets/captured.jpg)";
    const inventory = imageInventory(full, article.url);
    expect(inventory[0].url).toBe("/assets/captured.jpg");
    const repaired = normalizeImageDecisions([{ ...inventory[0], url: "https://example.com/assets/captured.jpg", remove: true, description: "保留原判断" }], article.url);
    expect(repaired[0]).toMatchObject({ url: "/assets/captured.jpg", remove: true, description: "保留原判断" });
  });

  it("keeps the original image source while displaying a localized thumbnail", () => {
    const decisions = imageInventory(article.markdown, article.url);
    const localized = localizeImagePreviews(decisions, { "https://example.com/pic.png": "assets/local.png" }, article.url);
    expect(localized[0]).toMatchObject({ url: "https://example.com/pic.png", previewUrl: "/assets/local.png" });
  });

  it("reads a local SiYuan resource directly for vision review", async () => {
    const proxyFixture = mockReview("RELEVANT");
    const fetchFixture = fetch;
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, options?: RequestInit) => {
      if (path === "/assets/local.png") return new Response("hello", { headers: { "Content-Type": "image/png" } });
      return fetchFixture(path, options);
    }));
    const result = await reviewImages({ ...article, markdown: "![本地图](assets/local.png)" }, "摘要", settings);
    expect(result.reviewed).toBe(1);
    expect(proxyFixture).toHaveLength(1);
    expect(proxyFixture[0].method).toBe("POST");
    expect(result.decisions[0].url).toBe("/assets/local.png");
  });

  it("reviews images beyond the former 12-image cap and reports completion", async () => {
    const requests = mockReview("RELEVANT");
    const longArticle = { ...article, markdown: Array.from({ length: 17 }, (_, i) => `![图${i}](https://example.com/${i}.png)`).join("\n\n") };
    const progress = vi.fn();
    const result = await reviewImages(longArticle, "长文摘要", settings, progress);
    expect(result.reviewed).toBe(17);
    expect(result.decisions.at(-1)?.status).toBe("reviewed");
    expect(requests.filter(request => request.method === "POST")).toHaveLength(17);
    expect(progress.mock.calls[0][0].reviewed).toBe(0);
    expect(progress.mock.calls.at(-1)![0].reviewed).toBe(17);
    expect(result.warnings).toEqual([]);
  });

  it("processes the entire inventory again in each full review", async () => {
    const requests = mockReview("RELEVANT");
    const source = { ...article, markdown: ["a", "b", "c"].map(name => `![${name}](https://example.com/${name}.png)`).join("\n") };
    await reviewImages(source, "摘要", settings);
    const result = await reviewImages(source, "摘要", settings);
    expect(requests.filter(request => request.method === "POST")).toHaveLength(6);
    expect(result.reviewed).toBe(3);
  });

  it("classifies a repeated URL once and keeps a decision for each reference", async () => {
    const requests = mockReview("RELEVANT");
    const source = { ...article, markdown: "![第一处](https://example.com/same.png)\n![第二处](https://example.com/same.png)" };
    const result = await reviewImages(source, "摘要", settings);
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
    expect(result.decisions).toHaveLength(2);
    expect(result.reviewed).toBe(2);
  });

  it("stores the text result before vision requests start", async () => {
    mockReview("RELEVANT");
    const events: string[] = [];
    const result = await reviewArticleDetailed(article, settings, article.markdown, { onTextReviewed: text => { events.push("text"); expect(text.markdown).toContain("Evidence"); }, onImageProgress: () => events.push("image") });
    expect(events[0]).toBe("text");
    expect(events.filter(event => event === "image")).toHaveLength(2);
    expect(result.imagesReviewed).toBe(1);
  });

  it("limits simultaneous vision requests to two while processing every image", async () => {
    mockReview("RELEVANT");
    const fetchFixture = fetch;
    let active = 0, maximum = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, options?: RequestInit) => {
      const request = JSON.parse(options!.body as string);
      if (request.method !== "POST") return fetchFixture(path, options);
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      try { return await fetchFixture(path, options); } finally { active--; }
    }));
    const source = { ...article, markdown: Array.from({ length: 7 }, (_, i) => `![${i}](https://example.com/${i}.png)`).join("\n") };
    const result = await reviewImages(source, "摘要", settings);
    expect(result.reviewed).toBe(7); expect(maximum).toBe(2);
  });

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

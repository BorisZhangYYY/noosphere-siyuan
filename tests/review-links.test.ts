/** 验证请求中的真实链接被隔离，编号还原覆盖四种协议及流式分包。 */
import { afterEach, expect, it, vi } from "vitest";
import { lockReviewLinks } from "../src/review/links";
import { partialReviewContent } from "../src/review/stream";
import { reviewArticleDetailed } from "../src/review/provider";
import { buildReviewPrompt, parseReviewResult } from "../src/review/perspectives";
import { DEFAULT_SETTINGS, type Settings } from "../src/types";

const image = "https://images.example/picture.png?literal=$&size=large";
const source = `![说明](${image})\n\n[资料](https://example.com/a_(b)?lang=zh#part)\n\n[本地](assets/local.png)`;
const response = (markdown: string): string => JSON.stringify({ title: "文章", markdown, summary: "内部摘要" });
afterEach(() => vi.unstubAllGlobals());

it("hides actual destinations and round-trips images, links, local assets, reference links, HTML and bare URLs", () => {
  const input = `${source}\n\n[参考][ref]\n[ref]: <https://example.com/file with spaces> "标题"\n\n<a href='/relative?a=1'>链接</a>\n\n<img src=/picture.png>\n\n<https://example.com/autolink>\n\n<mailto:author@example.com>\n\nhttps://example.com/plain\n\n\`https://example.com/code\`\n\n[^1]: 脚注的文字内容`;
  const locked = lockReviewLinks(input);
  expect(locked.input).not.toMatch(/https?:\/\//);
  expect(locked.input).not.toContain("assets/local.png");
  expect(locked.input).not.toContain("/relative");
  expect(locked.input).not.toContain("author@example.com");
  expect(locked.input).toContain("[^1]: 脚注的文字内容");
  expect(JSON.parse(locked.restoreResponse(response(locked.input))).markdown).toBe(input);
  const edited = locked.input.replace("![说明]", "![新说明]").replace("[资料]", "[阅读资料]");
  expect(JSON.parse(locked.restoreResponse(response(edited))).markdown).toBe(input.replace("![说明]", "![新说明]").replace("[资料]", "[阅读资料]"));
});

it("rejects damaged identifiers and invented URLs instead of discarding an image", () => {
  const locked = lockReviewLinks(source);
  expect(() => locked.restoreResponse(response(locked.input.replace(/__NOOSPHERE_LINK_\d+__/, "__NOOSPHERE_LINK_999__")))).toThrow("原稿已保留");
  expect(() => locked.restoreResponse(response(locked.input.replace(/__NOOSPHERE_LINK_\d+__/, "__BROKEN_ID__")))).toThrow("原稿已保留");
  expect(() => locked.restoreResponse(response(`![图](https://images.example/pictur.png)`))).toThrow("未知链接");
  expect(source).toContain(image);
});

it("restores JSON escaping and never forwards a partial identifier or unknown image to preview", () => {
  const raw = '![图](<https://example.com/a?x="quoted"&path=\\folder>)';
  const locked = lockReviewLinks(raw);
  const output = response(locked.input);
  for (let length = 1; length <= output.length; length++) {
    const preview = locked.preview(output.slice(0, length));
    if (preview !== undefined) expect(partialReviewContent(preview).markdown).not.toContain("__NOOSPHERE");
  }
  expect(partialReviewContent(locked.preview(output)!).markdown).toBe(raw);
  expect(JSON.parse(locked.restoreResponse(output)).markdown).toBe(raw);
  expect(locked.preview(response("![图](https://unknown.example/fake.png)"))).toBeUndefined();
});

it.each(["openai_chat", "openai_responses", "anthropic", "google"] as const)("locks the actual %s request and restores links before accepting its result", async format => {
  const article = { url: "https://example.com/post", title: "原文", markdown: source };
  vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    const input = format === "google" ? request.payload.contents[0].parts[0].text : format === "openai_responses" ? request.payload.input : request.payload.messages.at(-1).content;
    expect(input).not.toContain(article.url);
    expect(input).not.toContain(image);
    const markdown = input.slice(input.indexOf("\n\n") + 2);
    const text = response(markdown);
    const body = format === "anthropic" ? { content: [{ type: "text", text }] }
      : format === "openai_responses" ? { output_text: text }
        : format === "google" ? { candidates: [{ content: { parts: [{ text }] } }] }
          : { choices: [{ message: { content: text } }] };
    return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify(body) } }) };
  }));
  const accept = vi.fn();
  const result = await reviewArticleDetailed(article, { ...DEFAULT_SETTINGS, modelFormat: format, modelKey: "test", modelName: "test" }, article.markdown, { onTextReviewed: accept });
  expect(result.markdown).toContain(source);
  expect(result.markdown).not.toContain("__NOOSPHERE_LINK");
  expect(accept).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
});

it("restores streamed references before preview while preserving the completed-body signal", async () => {
  const article = { url: "https://example.com/post", title: "原文", markdown: source };
  vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
    const input = JSON.parse(options.body as string).messages.at(-1).content as string;
    const text = response(input.slice(input.indexOf("\n\n") + 2));
    const frames = [...text].map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + 'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n';
    return new Response(frames, { headers: { "Siyuan-Proxy-Content-Type": "text/event-stream" } });
  }));
  const previews: string[] = [];
  let completed = false;
  const result = await reviewArticleDetailed(article, { ...DEFAULT_SETTINGS, modelKey: "test", modelName: "test" }, source, { onTextDelta: text => {
    const content = partialReviewContent(text, () => { completed = true; });
    expect(content.markdown).not.toContain("__NOOSPHERE"); previews.push(content.markdown);
  } });
  expect(previews.at(-1)).toBe(source); expect(completed).toBe(true);
  expect(result.markdown).toContain(source);
});

it("puts hierarchy rules in the format prompt and preserves returned headings for any perspective", () => {
  const custom = { id: "custom", label: "课程笔记", description: "", prompt: "整理课程", template: "## 课程内容\n\n（原文章节作为子章节。）\n\n## 练习" };
  const article = { url: "https://example.com/post", title: "课程", markdown: "## 第一课" };
  const output = "## 课程内容\n\n### 第一课\n\n#### 示例\n\n## 练习";
  const customSettings = { ...DEFAULT_SETTINGS, reviewPerspective: custom.id, customPerspectives: [custom] };
  expect(buildReviewPrompt(customSettings)).toContain("比父标题至少低一级");
  expect(buildReviewPrompt(customSettings)).toContain(custom.template);
  expect(parseReviewResult(response(output), article, customSettings).markdown).toContain(output);
  const sameLevel = "## 正文\n\n## 第一节";
  expect(parseReviewResult(response(sameLevel), article, DEFAULT_SETTINGS).markdown).toContain(sameLevel);
});

/** 局部补丁的成本上限、取消语义和失败后的文字及原图保留。 */
import { afterEach, expect, it, vi } from "vitest";
import { lockReviewLinks } from "../src/review/links";
import { repairReviewLinks } from "../src/review/link-repair";
import { reviewArticleDetailed } from "../src/review/provider";
import { imageInventory, preserveSourceImages } from "../src/review/images";
import { RequestCancelledError } from "../src/siyuan/api";
import { DEFAULT_SETTINGS } from "../src/types";

const article = { url: "https://example.com/post", title: "原文", markdown: "段落\n\n![原图](https://example.com/photo.png)\n\n[资料](https://example.com/docs)" };
const settings = { ...DEFAULT_SETTINGS, modelKey: "test", modelName: "test" };
const response = (markdown: string): string => JSON.stringify({ title: "审阅稿", markdown, summary: "摘要" });
const envelope = (text: string): object => ({ ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: text } }] }) } }) });
afterEach(() => vi.unstubAllGlobals());

it("makes no repair request for valid identifiers", async () => {
  const links = lockReviewLinks(article.markdown);
  vi.stubGlobal("fetch", vi.fn());
  const result = await repairReviewLinks(response(links.input), links, settings);
  expect(result).toMatchObject({ attempts: 0, unresolved: 0 });
  expect(JSON.parse(result.response).markdown).toBe(article.markdown);
  expect(fetch).not.toHaveBeenCalled();
});

it("does not spend patch requests on truncated JSON or a source without candidate links", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const links = lockReviewLinks(article.markdown);
  expect((await repairReviewLinks('{"markdown":"truncated', links, settings)).response).toBe('{"markdown":"truncated');
  const noLinks = await repairReviewLinks(response("![图](https://unknown.example/photo.png)"), lockReviewLinks("只有文字"), settings);
  expect(noLinks).toMatchObject({ attempts: 0, unresolved: 1 });
  expect(fetch).not.toHaveBeenCalled();
});

it("bounds the issue and candidate inventory even for articles with hundreds of links", () => {
  const links = lockReviewLinks(Array.from({ length: 400 }, (_, i) => `![配图 ${i}](https://example.com/${i}.png)`).join("\n"));
  const damaged = response(Array.from({ length: 100 }, (_, i) => `![错误 ${i}](__BAD_${i}__)`).join("\n"));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const request = links.repairRequest(damaged, attempt, "失败".repeat(500))!;
    expect(request.issues).toHaveLength(8); expect(request.candidates.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(request).length).toBeLessThanOrEqual(6000);
    expect(JSON.stringify(request)).not.toContain("https://");
  }
});

it.each([1, 2, 3])("can recover on attempt %i without retransmitting or rewriting the article", async succeedsAt => {
  const longSource = `${article.markdown}\n\n${"长正文不会重复发送".repeat(2000)}`;
  const links = lockReviewLinks(longSource), candidate = links.input.match(/!\[原图\]\(([^)]+)\)/)![1];
  const damaged = response(links.input.replace(candidate, "__BROKEN_ID__"));
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string), payload = request.payload;
    const input = payload.messages.at(-1).content;
    expect(input.length).toBeLessThanOrEqual(6000);
    expect(input).not.toContain("https://"); expect(input).not.toContain("长正文不会重复发送".repeat(20));
    expect(payload.max_tokens).toBe(512); expect(request.timeout).toBe(30000);
    const plan = JSON.parse(input);
    if (calls) expect(plan.feedback).not.toBe("");
    return envelope(++calls === succeedsAt ? JSON.stringify({ patches: [{ issue: plan.issues[0].id, reference: candidate }] }) : '{"patches":[]}');
  }));
  const progress = vi.fn();
  const result = await repairReviewLinks(damaged, links, settings, undefined, progress);
  expect(result).toMatchObject({ attempts: succeedsAt, unresolved: 0 });
  expect(JSON.parse(result.response).markdown).toBe(longSource);
  expect(fetch).toHaveBeenCalledTimes(succeedsAt);
  expect(progress).toHaveBeenLastCalledWith(succeedsAt);
});

it("returns generated text after three invalid patches and retains the original photo outside the body", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    return envelope(request.payload.max_tokens === 512 ? '{"patches":[{"issue":"issue1","reference":"https://evil.example/wrong.png"}]}'
      : response("## 已审阅\n\n新的审阅文字\n\n![图](https://example.com/typo.png)\n\n结束"));
  }));
  const accept = vi.fn();
  const result = await reviewArticleDetailed(article, settings, article.markdown, { onTextReviewed: accept });
  expect(fetch).toHaveBeenCalledTimes(4); // 一次正文 + 最多三次短补丁。
  expect(result.linkRepair).toEqual({ attempts: 3, unresolved: 1 });
  expect(result.markdown).toContain("新的审阅文字"); expect(result.markdown).toContain("【图片引用待确认】");
  expect(result.markdown).not.toContain("typo.png"); expect(result.markdown).not.toContain("![原图]");
  expect(result.imageDecisions).toEqual([expect.objectContaining({ url: "https://example.com/photo.png", full: "![原图](https://example.com/photo.png)", unplaced: true, remove: false })]);
  expect(accept.mock.calls[0][0].imageDecisions).toEqual(result.imageDecisions);
  expect(article.markdown).toContain("photo.png");
});

it("keeps successful patches between attempts and degrades only unresolved destinations", async () => {
  const links = lockReviewLinks(article.markdown), photo = links.input.match(/!\[原图\]\(([^)]+)\)/)![1];
  const damaged = response("审阅文字\n\n![原图](__BAD__)\n\n[资料](__BAD2__)");
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async () => envelope(++call === 1 ? JSON.stringify({ patches: [{ issue: "issue1", reference: photo }] }) : '{"patches":[]}')));
  const result = await repairReviewLinks(damaged, links, settings);
  expect(result).toMatchObject({ attempts: 3, unresolved: 1 });
  expect(JSON.parse(result.response).markdown).toBe("审阅文字\n\n![原图](https://example.com/photo.png)\n\n资料【链接待确认】");
});

it("disables malformed Markdown, reference and HTML destinations while keeping their text", () => {
  const links = lockReviewLinks(article.markdown);
  const draft = '[标题](https://bad.example/a_(b) "标题")\n![图](<https://bad.example/a b> "图")\n[ref]: https://bad.example/x\n<img src="https://bad.example/x">\n<https://bad.example/x>';
  const result = links.fallbackResponse(response(draft));
  expect(result.unresolved).toBe(5);
  expect(JSON.parse(result.response).markdown).not.toContain("bad.example");
  expect(JSON.parse(result.response).markdown).toContain("标题【链接待确认】");
  expect(JSON.parse(result.response).markdown).toContain("图【图片引用待确认】");
});

it("propagates cancellation and does not spend remaining attempts or deliver a fallback", async () => {
  const links = lockReviewLinks(article.markdown), controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(); return envelope('{"patches":[]}'); }));
  await expect(repairReviewLinks(response("![图](__BAD__)"), links, settings, controller.signal)).rejects.toBeInstanceOf(RequestCancelledError);
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not duplicate source photos whose caption or relative destination changed", () => {
  const decisions = imageInventory("![新说明](/photo.png)", article.url);
  expect(preserveSourceImages(decisions, article)).toEqual(decisions);
});

it.each(["anthropic", "openai_responses", "google"] as const)("uses the shared %s short-request adapter with the repair budget", async format => {
  const links = lockReviewLinks(article.markdown), reference = links.input.match(/!\[原图\]\(([^)]+)\)/)![1];
  vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string), payload = request.payload;
    const input = format === "google" ? payload.contents[0].parts[0].text : format === "openai_responses" ? payload.input : payload.messages[0].content;
    expect(input).not.toContain("https://"); expect(input.length).toBeLessThanOrEqual(6000);
    expect(format === "google" ? payload.generationConfig.maxOutputTokens : format === "openai_responses" ? payload.max_output_tokens : payload.max_tokens).toBe(512);
    expect(request.timeout).toBe(30000);
    const text = JSON.stringify({ patches: [{ issue: "issue1", reference }] });
    const body = format === "anthropic" ? { content: [{ type: "text", text }] } : format === "openai_responses" ? { output_text: text } : { candidates: [{ content: { parts: [{ text }] } }] };
    return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify(body) } }) };
  }));
  const result = await repairReviewLinks(response("![原图](__BAD__)"), links, { ...settings, modelFormat: format });
  expect(result).toMatchObject({ attempts: 1, unresolved: 0 });
  expect(JSON.parse(result.response).markdown).toBe("![原图](https://example.com/photo.png)");
});

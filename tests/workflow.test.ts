import { afterEach, describe, expect, it, vi } from "vitest";
import { scrapeWithFirecrawl } from "../src/crawler/firecrawl";
import { appendArticle } from "../src/siyuan/writer";
import { localizeMarkdownImages } from "../src/images/localize";

afterEach(() => vi.unstubAllGlobals());

describe("article pipeline", () => {
  it("captures the main article through the SiYuan proxy", async () => {
    const fetchMock = vi.fn(async (_path: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      expect(request.url).toBe("https://api.firecrawl.dev/v2/scrape");
      expect(request.payload.url).toBe("https://example.com/post");
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ success: true, data: { markdown: "# Body", metadata: { title: "Title" } } }) } }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const article = await scrapeWithFirecrawl("https://example.com/post", "secret");
    expect(article).toMatchObject({ title: "Title", markdown: "# Body" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-document target before writing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { type: "p" } }) })));
    await expect(appendArticle("20260930120000-abcdefg", { url: "https://example.com", title: "Article", markdown: "text" }, "text"))
      .rejects.toThrow("不是文档");
  });

  it("appends the article beneath the selected document", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      requests.push({ path, body });
      const data = path === "/api/attr/getBlockAttrs"
        ? { type: "doc" }
        : [{ doOperations: [{ id: "20260930120001-bcdefgh" }] }];
      return { ok: true, json: async () => ({ code: 0, data }) };
    }));
    const id = await appendArticle(
      "20260930120000-abcdefg",
      { url: "https://example.com/post", title: "Article", markdown: "Original" },
      "Edited body",
    );
    expect(id).toBe("20260930120001-bcdefgh");
    expect(requests[1].path).toBe("/api/block/appendBlock");
    expect(requests[1].body).toMatchObject({ parentID: "20260930120000-abcdefg", dataType: "markdown" });
    expect(requests[1].body.data).toContain("Edited body");
  });

  it("keeps the preview text when an image cannot be localized", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 403, body: "forbidden" } }) })));
    const result = await localizeMarkdownImages("![photo](https://example.com/a.jpg)", "https://example.com/post");
    expect(result.markdown).toBe("![photo](https://example.com/a.jpg)");
    expect(result.warnings).toHaveLength(1);
  });

  it("replaces a downloaded image with its SiYuan asset path", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/asset/upload") {
        return { ok: true, json: async () => ({ code: 0, data: { succFiles: [{ path: "assets/local.png" }] } }) };
      }
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, contentType: "image/png", body: "aGVsbG8=" } }) };
    }));
    const result = await localizeMarkdownImages("![photo](/a.png)", "https://example.com/post");
    expect(result).toMatchObject({ markdown: "![photo](assets/local.png)", localized: 1, warnings: [] });
  });
});

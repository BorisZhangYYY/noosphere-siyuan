import { afterEach, describe, expect, it, vi } from "vitest";
import { scrapeWithFirecrawl } from "../src/crawler/firecrawl";
import { appendArticle } from "../src/siyuan/writer";
import { ImageLocalizationError, localizeMarkdownImages } from "../src/images/localize";
import { composeArticle } from "../src/article/compose";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("article pipeline", () => {
  it("filters self-page image placeholders when capturing and localizing an old article", async () => {
    const markdown = "![](https://example.com/post)\n\n正文 [来源](https://example.com/post)";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ success: true, data: { markdown } }) } }) })));
    expect((await scrapeWithFirecrawl("https://example.com/post", "secret")).markdown).toBe("正文 [来源](https://example.com/post)");
    vi.mocked(fetch).mockClear();
    expect(await localizeMarkdownImages(markdown, "https://example.com/post")).toMatchObject({ localized: 0, warnings: [], markdown: "\n\n正文 [来源](https://example.com/post)" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the reviewed title once when the draft begins with a heading", () => {
    const markdown = composeArticle(
      { url: "https://example.com/post", title: "Article - Site", markdown: "# Article\n\nBody" },
      "# Article\n\nBody",
    );
    expect(markdown.match(/^# Article$/gm)).toHaveLength(1);
    expect(markdown).toContain("> 来源：<https://example.com/post>");
    expect(markdown).toContain("Body");
  });

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

  it("retains a blocked image link without stopping the article save", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 403, body: "forbidden" } }) })));
    const result = await localizeMarkdownImages("![photo](https://example.com/a.jpg)", "https://example.com/post");
    expect(result).toMatchObject({ markdown: "![photo](https://example.com/a.jpg)", localized: 0 });
    expect(result.warnings).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not download an image already confirmed unavailable by review", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const markdown = "![bad](/bad.png#fragment)\n![same](https://example.com/bad.png)";
    const result = await localizeMarkdownImages(markdown, "https://example.com/post", ["https://example.com/bad.png"]);
    expect(result).toMatchObject({ markdown, localized: 0, warnings: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops a stalled upload while retaining earlier assets and the remaining remote links", async () => {
    vi.useFakeTimers(); let uploads = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/asset/upload") return { ok: true, json: () => ++uploads === 1
        ? Promise.resolve({ code: 0, data: { succFiles: [{ path: "assets/first.png" }] } }) : new Promise(() => undefined) };
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: "aGVsbG8=", contentType: "image/png" } }) };
    }));
    const markdown = [0, 1, 2].map(i => `![${i}](https://example.com/${i}.png)`).join("\n");
    const pending = localizeMarkdownImages(markdown, "https://example.com/post");
    await vi.advanceTimersByTimeAsync(30000);
    const result = await pending;
    expect(result.localized).toBe(1); expect(result.warnings[0]).toContain("超时");
    expect(result.markdown).toBe("![0](assets/first.png)\n![1](https://example.com/1.png)\n![2](https://example.com/2.png)");
    expect(fetch).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the whole image batch and discards results arriving after its deadline", async () => {
    vi.useFakeTimers(); let uploads = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      await new Promise(resolve => setTimeout(resolve, 25000));
      return { ok: true, json: async () => ({ code: 0, data: path === "/api/asset/upload"
        ? { succFiles: [{ path: `assets/${uploads++}.png` }] }
        : { status: 200, body: "aGVsbG8=", contentType: "image/png" } }) };
    }));
    const markdown = [0, 1, 2].map(i => `![${i}](https://example.com/${i}.png)`).join("\n");
    const pending = localizeMarkdownImages(markdown, "https://example.com/post");
    await vi.advanceTimersByTimeAsync(120000);
    const result = await pending;
    expect(result.localized).toBe(2); expect(result.warnings[0]).toContain("120 秒");
    expect(result.markdown).toContain("![2](https://example.com/2.png)");
    await vi.advanceTimersByTimeAsync(10000);
    expect(result.localized).toBe(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 404, 413, 422, 500, 503, 599])("stops on upload HTTP %i and returns completed assets without processing later images", async status => {
    let uploads = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/asset/upload") {
        if (++uploads === 2) return { ok: false, status };
        return { ok: true, json: async () => ({ code: 0, data: { succFiles: [{ path: "assets/first.png" }] } }) };
      }
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: "aGVsbG8=", contentType: "image/png" } }) };
    }));
    const markdown = [0, 1, 2].map(i => `![${i}](https://example.com/${i}.png)`).join("\n");
    await expect(localizeMarkdownImages(markdown, "https://example.com/post")).rejects.toMatchObject({ code: status,
      partial: { localized: 1, markdown: "![0](assets/first.png)\n![1](https://example.com/1.png)\n![2](https://example.com/2.png)" } });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("rejects a coded upload response even when it includes an apparent asset path", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => ({ ok: true, json: async () => path === "/api/asset/upload"
      ? { code: -7, msg: "storage unavailable", data: { succFiles: [{ path: "assets/invalid.png" }] } }
      : { code: 0, data: { status: 200, body: "aGVsbG8=", contentType: "image/png" } } })));
    await expect(localizeMarkdownImages("![photo](https://example.com/a.jpg)", "https://example.com/post")).rejects.toMatchObject({ code: -7, partial: { localized: 0 } });
    expect(fetch).toHaveBeenCalledTimes(2);
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

  it("localizes the whole article without a per-article image count cap", async () => {
    let uploads = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => path === "/api/asset/upload"
      ? { ok: true, json: async () => ({ code: 0, data: { succFiles: [{ path: `assets/${uploads++}.png` }] } }) }
      : { ok: true, json: async () => ({ code: 0, data: { status: 200, contentType: "image/png", body: "aGVsbG8=" } }) }));
    const source = Array.from({ length: 37 }, (_, i) => `![${i}](https://example.com/${i}.png)`).join("\n");
    const result = await localizeMarkdownImages(source, "https://example.com/post");
    expect(result.localized).toBe(37); expect(uploads).toBe(37);
    expect(result.markdown).toContain("![36](assets/36.png)");
    expect(result.warnings).toEqual([]);
  });

  it("does not redownload local assets with or without a leading slash", async () => {
    const fetchFixture = vi.fn(); vi.stubGlobal("fetch", fetchFixture);
    const markdown = "![一](assets/a.png)\n![二](/assets/b.png)";
    expect((await localizeMarkdownImages(markdown, "https://example.com/post")).markdown).toBe(markdown);
    expect(fetchFixture).not.toHaveBeenCalled();
  });
});

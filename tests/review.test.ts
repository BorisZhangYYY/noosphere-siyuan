import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewArticle } from "../src/review/provider";
import { DEFAULT_SETTINGS, type Article } from "../src/types";

const article: Article = { url: "https://example.com/post", title: "Article", markdown: "# Article\nBody" };

afterEach(() => vi.unstubAllGlobals());

describe("model review adapters", () => {
  it("uses an OpenAI Chat endpoint when the configured base has no version path", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      expect(request.url).toBe("https://model.example/v1/chat/completions");
      expect(request.headers[0].Authorization).toBe("Bearer secret");
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: "# Clean article" } }] }) } }) };
    }));
    const reviewed = await reviewArticle(article, { ...DEFAULT_SETTINGS, modelBaseUrl: "https://model.example", modelKey: "secret", modelName: "model" });
    expect(reviewed).toBe("# Clean article");
  });

  it("uses Anthropic Messages for an existing compatible model", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      expect(request.url).toBe("https://api.example/coding/v1/messages");
      expect(request.headers[0]).toMatchObject({ "x-api-key": "secret", "anthropic-version": "2023-06-01" });
      expect(request.payload.messages[0].content).toContain("# Article");
      return { ok: true, json: async () => ({ code: 0, data: { status: 200, body: JSON.stringify({ content: [{ type: "text", text: "# Reviewed article" }] }) } }) };
    }));
    const reviewed = await reviewArticle(article, {
      ...DEFAULT_SETTINGS,
      modelFormat: "anthropic",
      modelBaseUrl: "https://api.example/coding/",
      modelKey: "secret",
      modelName: "model",
    });
    expect(reviewed).toBe("# Reviewed article");
  });
});

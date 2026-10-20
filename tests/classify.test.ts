// @vitest-environment jsdom
/** 验证分类发现、路径拼接、模型选择阈值与按标题落库的幂等语义。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attrFromIal, classificationCandidates, descriptionFromMarkdown, discoverCategories, refreshCategoryIndex, renderCategoryIndex } from "../src/siyuan/tree";
import { classifyArticle, CLASSIFY_CONFIDENCE } from "../src/review/classify";
import { ensureArticleDocument, findDocumentByTitle, safeDocumentTitle } from "../src/siyuan/destination";
import { kernelPost } from "../src/siyuan/api";
import { proxyRequest } from "../src/siyuan/api";
import { DEFAULT_SETTINGS } from "../src/types";

vi.mock("../src/siyuan/api", () => ({
  kernelPost: vi.fn(),
  proxyRequest: vi.fn(),
}));

const rootId = "20260101000000-aaaaaaa";
const aiId = "20260101000000-bbbbbbb";
const llmId = "20260101000000-ccccccc";
const gameId = "20260101000000-ddddddd";
const article = { title: "文章标题", url: "https://example.com/post", markdown: "正文" };
const settings = { ...DEFAULT_SETTINGS, modelKey: "k", modelName: "m", modelBaseUrl: "https://example.com/v1" };

function row(id: string, parentId: string, content: string, extra = ""): { id: string; parent_id: string; content: string; ial: string; type: string } {
  return { id, parent_id: parentId, content, ial: `{: id="${id}" custom-zl-category="true"${extra}}`, type: "d" };
}

beforeEach(() => {
  vi.mocked(kernelPost).mockReset();
  vi.mocked(proxyRequest).mockReset();
});
afterEach(() => { vi.resetAllMocks(); });

describe("category attributes", () => {
  it("reads a custom attribute out of IAL and unescapes entities", () => {
    expect(attrFromIal('{: id="x" custom-zl-desc="AI &amp; 工具"}', "custom-zl-desc")).toBe("AI & 工具");
    expect(attrFromIal('{: id="x"}', "custom-zl-desc")).toBe("");
  });

  it("takes the first non-heading paragraph as the description", () => {
    expect(descriptionFromMarkdown("---\n\n# 标题\n\n这里是介绍。\n\n第二段")).toBe("这里是介绍。");
    expect(descriptionFromMarkdown("")).toBe("");
  });

  it("renders block links and escapes Markdown-significant characters", () => {
    expect(renderCategoryIndex([{ id: aiId, title: "A *B* [C]" }])).toBe(`* [A \\*B\\* \\[C\\]](siyuan://blocks/${aiId})`);
  });
});

describe("category discovery", () => {
  it("builds full paths from parent links and only exposes categories in the prompt candidates", async () => {
    vi.mocked(kernelPost).mockImplementation(async (path) => {
      if (path !== "/api/query/sql") throw new Error(`unexpected ${path}`);
      return [row(aiId, rootId, "AI 相关", ' custom-zl-desc="AI 文章"'), row(llmId, aiId, "大模型"), row(gameId, rootId, "游戏相关")];
    });
    const categories = await discoverCategories();
    const byId = new Map(categories.map(item => [item.id, item]));
    expect(byId.get(aiId)).toMatchObject({ path: "AI 相关", description: "AI 文章" });
    expect(byId.get(llmId)).toMatchObject({ path: "AI 相关 / 大模型", description: "" });
    expect(byId.get(gameId)).toMatchObject({ path: "游戏相关" });
    expect(classificationCandidates(categories).find(item => item.id === llmId)).toEqual({ id: llmId, path: "AI 相关 / 大模型", description: "" });
  });

  it("ignores rows without the category attribute instead of trusting the LIKE filter", async () => {
    vi.mocked(kernelPost).mockImplementation(async () => [
      { id: aiId, parent_id: rootId, content: "AI", ial: `{: id="${aiId}"}`, type: "d" },
    ]);
    expect(await discoverCategories()).toEqual([]);
  });
});

describe("automatic classification", () => {
  const categories = [{ id: aiId, name: "AI 相关", description: "AI 文章", path: "AI 相关", parentId: rootId }];

  it("never calls the model when no category exists", async () => {
    const result = await classifyArticle("标题", "正文", [], settings);
    expect(result.categoryId).toBeNull();
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  it("accepts an existing category above the confidence threshold", async () => {
    vi.mocked(proxyRequest).mockResolvedValue({ body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ collection_id: aiId, confidence: 0.84, reason: "主题匹配" }) } }] }), status: 200, contentType: "application/json" });
    const result = await classifyArticle("标题", "正文", categories, settings);
    expect(result).toEqual({ categoryId: aiId, confidence: 0.84, reason: "主题匹配" });
  });

  it("falls back to the root below the threshold and for invented ids", async () => {
    vi.mocked(proxyRequest).mockResolvedValueOnce({ body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ collection_id: aiId, confidence: CLASSIFY_CONFIDENCE - 0.01, reason: "" }) } }] }), status: 200, contentType: "application/json" });
    expect((await classifyArticle("标题", "正文", categories, settings)).categoryId).toBeNull();
    vi.mocked(proxyRequest).mockResolvedValueOnce({ body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ collection_id: "20260101000000-zzzzzzz", confidence: 0.9, reason: "" }) } }] }), status: 200, contentType: "application/json" });
    expect((await classifyArticle("标题", "正文", categories, settings)).categoryId).toBeNull();
  });

  it("rejects a response without any JSON object", async () => {
    vi.mocked(proxyRequest).mockResolvedValue({ body: JSON.stringify({ choices: [{ message: { content: "没有分类" } }] }), status: 200, contentType: "application/json" });
    await expect(classifyArticle("标题", "正文", categories, settings)).rejects.toThrow("分类结果不是有效的 JSON 对象");
  });
});

describe("saving under a category", () => {
  it("replaces illegal filename characters and keeps a readable title", () => {
    expect(safeDocumentTitle('  A/B: "C"  ')).toBe("A／B： ＂C＂");
  });

  it("creates a new document under the category hpath when none exists", async () => {
    vi.mocked(kernelPost).mockImplementation(async (path, payload) => {
      if (path === "/api/notebook/lsNotebooks") return { notebooks: [] };
      if (path === "/api/filetree/getHPathByID") return "/知流/AI 相关";
      if (path === "/api/filetree/getPathByID") return { notebook: "box" };
      if (path === "/api/filetree/getIDsByHPath") return [];
      if (path === "/api/filetree/createDocWithMd") {
        expect(payload).toMatchObject({ notebook: "box", path: "/知流/AI 相关/文章标题" });
        return "20260101000000-eeeeeee";
      }
      throw new Error(`unexpected ${path}`);
    });
    const result = await ensureArticleDocument(aiId, article, "正文");
    expect(result).toEqual({ documentId: "20260101000000-eeeeeee", created: true });
  });

  it("updates the existing document instead of creating a duplicate", async () => {
    vi.mocked(kernelPost).mockImplementation(async (path) => {
      if (path === "/api/notebook/lsNotebooks") return { notebooks: [] };
      if (path === "/api/filetree/getHPathByID") return "/知流/AI 相关";
      if (path === "/api/filetree/getPathByID") return { notebook: "box" };
      if (path === "/api/filetree/getIDsByHPath") return ["20260101000000-fffffff"];
      if (path === "/api/block/updateBlock") return null;
      throw new Error(`unexpected ${path}`);
    });
    const result = await ensureArticleDocument(aiId, article, "正文");
    expect(result).toEqual({ documentId: "20260101000000-fffffff", created: false });
    expect(vi.mocked(kernelPost).mock.calls.some(([path]) => path === "/api/filetree/createDocWithMd")).toBe(false);
  });

  it("finds a document by its full hpath and tolerates a notebook passed as parent", async () => {
    vi.mocked(kernelPost).mockImplementation(async (path) => {
      if (path === "/api/notebook/lsNotebooks") return { notebooks: [{ id: rootId, name: "知流" }] };
      if (path === "/api/filetree/getIDsByHPath") return [];
      throw new Error(`unexpected ${path}`);
    });
    expect(await findDocumentByTitle(rootId, "文章标题")).toBeNull();
  });
});

describe("category index refresh", () => {
  it("rewrites only the marked block and lists child documents", async () => {
    const indexId = "20260101000000-ggggggg";
    vi.mocked(kernelPost).mockImplementation(async (path, payload) => {
      if (path === "/api/query/sql") {
        const stmt = (payload as { stmt: string }).stmt;
        if (stmt.includes("custom-zl-index")) return [{ id: indexId, parent_id: aiId, content: "", ial: `{: id="${indexId}" custom-zl-index="true"}`, type: "l" }];
        return [{ id: llmId, content: "大模型" }];
      }
      if (path === "/api/block/getChildBlocks") return [{ id: llmId, type: "d" }, { id: aiId, type: "d" }];
      if (path === "/api/block/updateBlock") {
        expect(payload).toEqual({ id: indexId, dataType: "markdown", data: `* [大模型](siyuan://blocks/${llmId})` });
        return null;
      }
      throw new Error(`unexpected ${path}`);
    });
    expect(await refreshCategoryIndex(aiId)).toBe(indexId);
  });

  it("does nothing when the category has no marked index block", async () => {
    vi.mocked(kernelPost).mockResolvedValue([]);
    expect(await refreshCategoryIndex(aiId)).toBeNull();
    expect(vi.mocked(kernelPost).mock.calls.some(([path]) => path === "/api/block/updateBlock")).toBe(false);
  });
});

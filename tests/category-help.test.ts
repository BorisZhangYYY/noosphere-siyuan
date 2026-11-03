/** 分类根指引与工作台保存流程保持一致，升级时替换旧的自动保存说明。 */
import { afterEach, expect, it, vi } from "vitest";
import { ensureClassificationRoot } from "../src/siyuan/category-management";

const root = "20261103000000-aaaaaaa", directory = "20261103000000-bbbbbbb";
const heading = "20261103000000-ccccccc", help = "20261103000000-ddddddd";
vi.mock("../src/siyuan/location", async original => ({
  ...await original<typeof import("../src/siyuan/location")>(),
  locateDocument: vi.fn(async () => ({ id: root })), classificationRootDocumentId: vi.fn(async () => root),
}));
vi.mock("../src/siyuan/tree", async original => ({
  ...await original<typeof import("../src/siyuan/tree")>(), refreshCategoryIndex: vi.fn(async () => null),
}));
afterEach(() => vi.unstubAllGlobals());

it("upgrades v3 help to instruct users to click Save Article before automatic classification", async () => {
  const writes: Array<{ path: string; payload: Record<string, any> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
    const payload = JSON.parse(init.body as string); writes.push({ path, payload });
    let data: unknown = null;
    if (path === "/api/attr/getBlockAttrs") data = payload.id === root
      ? { "custom-zl-root-directory-heading": directory, "custom-zl-root-help-heading": heading, "custom-zl-root-help-block": help }
      : { "custom-zl-classification-help": root, "custom-zl-help-version": "3" };
    if (path === "/api/block/getChildBlocks") data = [{ id: directory, type: "h" }, { id: heading, type: "h" }, { id: help, type: "l" }];
    if (path === "/api/block/updateBlock") data = [{ doOperations: [{ id: help }] }];
    return { ok: true, json: async () => ({ code: 0, data }) };
  }));
  await ensureClassificationRoot(root);
  const updated = writes.find(write => write.path === "/api/block/updateBlock" && write.payload.id === help);
  expect(updated?.payload.data).toContain("点击“保存文章”才分类并保存");
  expect(updated?.payload.data).not.toContain("审阅成功后保存");
  expect(writes).toContainEqual({ path: "/api/attr/setBlockAttrs", payload: { id: help,
    attrs: { "custom-zl-classification-help": root, "custom-zl-help-version": "4" } } });
});

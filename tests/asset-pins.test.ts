/** 正文未引用的素材必须计入思源资源引用，否则会被未引用资源清理删除。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAssetPins, localAssetReferences, pinEntryKey, stripPinAttributes, syncAssetPins, unreferencedAssets } from "../src/images/pins";

afterEach(() => vi.unstubAllGlobals());

function mockKernel(existing: Record<string, string>) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    requests.push({ path, body });
    const data = path === "/api/attr/getBlockAttrs" ? existing : null;
    return { ok: true, json: async () => ({ code: 0, data }) };
  }));
  return requests;
}

describe("history asset pins", () => {
  it("isolates fallback IDs sharing their first ten characters and retains ambiguous legacy pins", async () => {
    const first = "capture-lz9x-a1", second = "capture-lz9x-b2";
    expect(pinEntryKey(first)).not.toBe(pinEntryKey(second));
    const legacy = "custom-data-assets-zl-capturelz9-1";
    const other = `custom-data-assets-zl-${pinEntryKey(second)}-1`;
    const requests = mockKernel({ [legacy]: "assets/legacy.png", [other]: "assets/other.png" });
    await clearAssetPins("doc", first);
    expect(requests.some(request => request.path === "/api/attr/setBlockAttrs")).toBe(false);
  });
  it("collects only local SiYuan asset paths from markdown, DOM and decisions", () => {
    const text = JSON.stringify({
      markdown: "![a](assets/a.png)\n![b](/assets/b.png)\n![远程](https://example.com/assets/c.png)",
      blockDOM: '<img src="assets/a.png" data-src="assets/a.png"><img src="/assets/d.webp?x=1">',
    });
    expect(localAssetReferences(text)).toEqual(["assets/a.png", "assets/b.png", "assets/d.webp?x=1"]);
  });

  it("keeps only assets the saved document body does not reference", () => {
    const body = "正文 ![a](assets/a.png) 和 ![b](/assets/b.png)";
    const candidates = ["assets/a.png", "/assets/b.png", "assets/removed.png", "assets/unplaced.png", "assets/removed.png"];
    expect(unreferencedAssets(body, candidates)).toEqual(["assets/removed.png", "assets/unplaced.png"]);
  });

  it("pins one attribute per unreferenced asset, updates changed pins and clears stale ones", async () => {
    const key = pinEntryKey("77a95c98-03d1-4717-b0f3-5fdd0e471238");
    const requests = mockKernel({
      title: "文章",
      [`custom-data-assets-zl-${key}-1`]: "assets/stale.png",
      [`custom-data-assets-zl-${key}-2`]: "assets/keep.png",
      [`custom-data-assets-zl-${key}-3`]: "assets/gone.png",
    });
    expect(await syncAssetPins("20261102101655-sikxj3w", "77a95c98-03d1-4717-b0f3-5fdd0e471238", ["assets/keep.png", "assets/new.png"]))
      .toMatchObject({ pinned: 2, changed: true });
    const write = requests.find(request => request.path === "/api/attr/setBlockAttrs")!;
    expect(write.body.id).toBe("20261102101655-sikxj3w");
    expect(write.body.attrs).toEqual({
      [`custom-data-assets-zl-${key}-1`]: "assets/keep.png",
      [`custom-data-assets-zl-${key}-2`]: "assets/new.png",
      [`custom-data-assets-zl-${key}-3`]: "",
    });
  });

  it("writes nothing when the document already carries the expected pins", async () => {
    const key = pinEntryKey("77a95c98-03d1-4717-b0f3-5fdd0e471238");
    const requests = mockKernel({ [`custom-data-assets-zl-${key}-1`]: "assets/keep.png", [`custom-data-assets-zl-${key}-2`]: "assets/new.png" });
    expect(await syncAssetPins("20261102101655-sikxj3w", "77a95c98-03d1-4717-b0f3-5fdd0e471238", ["assets/keep.png", "assets/new.png"]))
      .toMatchObject({ pinned: 2, changed: false });
    expect(requests.some(request => request.path === "/api/attr/setBlockAttrs")).toBe(false);
  });

  it("releases pins when a history entry is deleted", async () => {
    const key = pinEntryKey("87ffaca8-e605-4e07-bf32-24247fd8957c");
    const requests = mockKernel({ [`custom-data-assets-zl-${key}-1`]: "assets/old.png", title: "文章" });
    expect(await clearAssetPins("20261024151839-j8xl5mk", "87ffaca8-e605-4e07-bf32-24247fd8957c")).toBe(1);
    expect(requests.find(request => request.path === "/api/attr/setBlockAttrs")!.body.attrs)
      .toEqual({ [`custom-data-assets-zl-${key}-1`]: "" });
  });

  it("does nothing without a document or assets", async () => {
    const requests = mockKernel({});
    expect(await syncAssetPins("", "entry", ["assets/a.png"])).toMatchObject({ pinned: 0, changed: false });
    expect(await syncAssetPins("20261102101655-sikxj3w", "entry", [])).toMatchObject({ pinned: 0, changed: false });
    expect(await clearAssetPins("", "entry")).toBe(0);
    // 未保存时完全不请求；已保存但无素材时只读取，不写入空绑定。
    expect(requests.map(request => request.path)).toEqual(["/api/attr/getBlockAttrs"]);
    expect(pinEntryKey("capture-lz9x-a1")).toMatch(/^[a-z0-9]+$/);
  });

  it("releases pins once every material image is back in the saved body", async () => {
    const key = pinEntryKey("346c9f2f-c21e-4352-8561-f90f8ad71d32");
    const requests = mockKernel({ [`custom-data-assets-zl-${key}-1`]: "assets/logo.png" });
    expect(await syncAssetPins("20261102101655-sikxj3w", "346c9f2f-c21e-4352-8561-f90f8ad71d32", []))
      .toMatchObject({ pinned: 0, changed: true });
    expect(requests.find(request => request.path === "/api/attr/setBlockAttrs")!.body.attrs)
      .toEqual({ [`custom-data-assets-zl-${key}-1`]: "" });
  });

  it("strips only owned IAL attributes, preserving body text and neighboring resource attributes", () => {
    const text = 'custom-data-assets-zl is documentation ![x](assets/body.png)\n{: id="doc" custom-data-assets-zl-entry-1="assets/pin.png" custom-other="assets/other.png"}';
    expect(stripPinAttributes(text)).toBe('custom-data-assets-zl is documentation ![x](assets/body.png)\n{: id="doc" custom-other="assets/other.png"}');
  });

  it("does not read its own pins back as body references", () => {
    const kramdown = '正文 ![a](assets/a.png)\n{: id="20261102101655-sikxj3w" custom-data-assets-zl-77a95c98-1="assets/material.png"}';
    expect(stripPinAttributes(kramdown)).toBe('正文 ![a](assets/a.png)\n{: id="20261102101655-sikxj3w"}');
    // 绑定行不算正文引用，否则下一轮会把刚写好的绑定当成已引用素材再清空。
    expect(unreferencedAssets(kramdown, ["assets/material.png"])).toEqual([]);
    expect(unreferencedAssets(stripPinAttributes(kramdown), ["assets/material.png"])).toEqual(["assets/material.png"]);
  });
});

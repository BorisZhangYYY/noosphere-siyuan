/** 验证分发路径映射保留集市可访问的绝对图片地址。 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("maps local documentation paths without rewriting the GitHub Raw image URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "noosphere-package-"));
  const imageURL = "https://raw.githubusercontent.com/BorisZhangYYY/noosphere-siyuan/main/.docs/images/workbench.png";
  try {
    for (const path of ["dist", ".docs/images", ".project"]) await mkdir(join(root, path), { recursive: true });
    const source = `![工作台](${imageURL})\n[说明](.docs/README.en.md)\n[开发](.project/development.md)`;
    const english = `![Workbench](${imageURL})\n[开发](../.project/development.md)\n[中文](../README.md)`;
    const manifest = JSON.parse(await readFile(resolve("plugin.json"), "utf8"));
    const icon = await readFile(resolve("icon.png"));
    const image = await readFile(resolve(".docs/images/workbench.png"));
    for (const [name, content] of Object.entries({
      "plugin.json": JSON.stringify(manifest), "icon.png": icon, "icon.svg": "<svg/>", "README.md": source,
      "LICENSE": "MIT", ".docs/README.en.md": english, ".docs/images/workbench.png": image,
      ".project/development.md": "[英文](../.docs/README.en.md)", "CONTRIBUTING.md": "[开发](.project/development.md)",
    })) await writeFile(join(root, name), content);
    execFileSync(process.execPath, [resolve("scripts/finish-build.mjs")], { cwd: root });
    expect(await readFile(join(root, "dist/README.md"), "utf8")).toBe(source.replace("(.docs/", "(docs/").replace("(.project/", "(project/"));
    expect(await readFile(join(root, "dist/docs/README.en.md"), "utf8")).toBe(english.replace("(../.project/", "(../project/"));
    for (const path of Object.values(manifest.readme) as string[]) expect(await readFile(join(root, "dist", path), "utf8")).toContain(imageURL);
    // 使用原生字节比较，避免测试框架逐项遍历大图导致 CI 超时。
    expect((await readFile(join(root, "dist/icon.png"))).equals(icon)).toBe(true);
    expect((await readFile(join(root, "dist/docs/images/workbench.png"))).equals(image)).toBe(true);
    expect(await readFile(join(root, "dist/project/development.md"), "utf8")).toBe("[英文](../docs/README.en.md)");
  } finally { await rm(root, { recursive: true, force: true }); }
});

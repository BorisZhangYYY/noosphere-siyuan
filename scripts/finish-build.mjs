/** Copy SiYuan's required metadata into the distributable plugin directory. */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * 仓库说明保留原有路径，分发时将链接映射到可被思源同步的普通目录。
 * @param {string} source
 * @param {string} target
 * @returns {Promise<void>}
 */
async function copyMarkdown(source, target) {
  const markdown = await readFile(source, "utf8");
  await writeFile(target, markdown.replace(/\]\((\.\.\/)?\.(docs|project)\//g, "]($1$2/"));
}

await Promise.all([
  mkdir("dist/docs/images", { recursive: true }),
  mkdir("dist/project", { recursive: true }),
]);

await Promise.all([
  copyFile("plugin.json", "dist/plugin.json"),
  copyFile("icon.png", "dist/icon.png"),
  copyFile("icon.svg", "dist/icon.svg"),
  copyMarkdown("README.md", "dist/README.md"),
  copyFile("LICENSE", "dist/LICENSE"),
  copyMarkdown(".docs/README.en.md", "dist/docs/README.en.md"),
  copyFile(".docs/images/workbench.png", "dist/docs/images/workbench.png"),
  copyMarkdown(".project/development.md", "dist/project/development.md"),
  copyMarkdown("CONTRIBUTING.md", "dist/CONTRIBUTING.md"),
]);

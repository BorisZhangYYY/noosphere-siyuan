/** Copy SiYuan's required metadata into the distributable plugin directory. */
import { copyFile, mkdir } from "node:fs/promises";

await Promise.all([
  mkdir("dist/.docs/images", { recursive: true }),
  mkdir("dist/.project", { recursive: true }),
]);

await Promise.all([
  copyFile("plugin.json", "dist/plugin.json"),
  copyFile("icon.png", "dist/icon.png"),
  copyFile("icon.svg", "dist/icon.svg"),
  copyFile("README.md", "dist/README.md"),
  copyFile("LICENSE", "dist/LICENSE"),
  copyFile(".docs/README.en.md", "dist/.docs/README.en.md"),
  copyFile(".docs/images/workbench.png", "dist/.docs/images/workbench.png"),
  copyFile(".project/development.md", "dist/.project/development.md"),
  copyFile("CONTRIBUTING.md", "dist/CONTRIBUTING.md"),
]);

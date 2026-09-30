/** Copy SiYuan's required metadata into the distributable plugin directory. */
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist/.docs", { recursive: true });

await Promise.all([
  copyFile("plugin.json", "dist/plugin.json"),
  copyFile("README.md", "dist/README.md"),
  copyFile(".docs/usage.md", "dist/.docs/usage.md"),
]);

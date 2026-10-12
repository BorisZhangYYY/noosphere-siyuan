/** 思源运行时由宿主提供，回归测试通过接口替身加载插件入口。 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { siyuan: fileURLToPath(new URL("./tests/fixtures/siyuan.ts", import.meta.url)) } },
});

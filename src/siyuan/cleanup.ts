/** 卸载只删除知流自身的存储目录，保留思源文档及共享资源。 */
export async function removePluginStorage(): Promise<void> {
  const response = await fetch("/api/file/removeFile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/data/storage/petal/noosphere-siyuan" }),
  });
  if (!response.ok) throw new Error(`清理知流数据失败：HTTP ${response.status}`);
  const result = await response.json() as { code: number; msg?: string };
  if (result.code !== 0 && result.code !== 404) throw new Error(result.msg || "清理知流数据失败");
}

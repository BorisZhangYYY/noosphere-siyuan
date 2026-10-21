/** 监听真实文档树变化，合并事件批次并维护全部受管目录及其祖先层级。 */
import { kernelPost } from "./api";
import { INDEX_ATTR, INDEX_ENABLED_ATTR, refreshCategoryIndex } from "./tree";

const TREE_COMMANDS = new Set(["create", "createDoc", "removeDoc", "moveDoc", "moveDocs", "rename", "renameDoc", "heading2doc", "li2doc", "createdailynote", "mount", "removeBox", "openBox", "closeBox", "sort", "setDocSort", "syncFinish", "refreshFileTree"]);
export interface IndexMaintenanceSettings { rootDocumentId: string; autoCreateIndex: boolean }

export class CategoryIndexMaintenance {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private pending = false;
  private stopped = false;
  constructor(private readonly settings: () => IndexMaintenanceSettings, private readonly onError: (error: unknown) => void) {}

  /** 内核命令覆盖侧栏操作、其他窗口与 API 写入，不依赖用户重新打开索引页。 */
  onMessage = (event: { detail?: { cmd?: string } }): void => {
    if (TREE_COMMANDS.has(event.detail?.cmd || "")) this.schedule();
  };
  schedule(): void {
    if (this.stopped) return;
    this.pending = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 250);
  }
  async flush(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (this.pending && !this.stopped) {
        this.pending = false;
        await kernelPost("/api/sqlite/flushTransaction", {});
        const pages = await kernelPost<Array<{ id: string }>>("/api/query/sql", { stmt: `SELECT DISTINCT id FROM blocks WHERE type = 'd' AND (ial LIKE '%${INDEX_ENABLED_ATTR}%' OR id IN (SELECT root_id FROM blocks WHERE ial LIKE '%${INDEX_ATTR}%')) LIMIT 2147483647` });
        // 首次创建由保存文章的前端负责；其他窗口只维护已登记的目录，避免同时插入。
        const targets = new Map(pages.map(page => [page.id, this.settings().autoCreateIndex]));
        for (const [id, create] of targets) {
          if (this.stopped) break;
          try { await refreshCategoryIndex(id, { create }); } catch (error) { this.onError(error); }
        }
      }
    } catch (error) { this.onError(error); }
    finally { this.running = false; }
  }
  stop(): void { this.stopped = true; this.pending = false; if (this.timer) clearTimeout(this.timer); }
}

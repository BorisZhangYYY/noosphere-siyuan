/** 素材绑定编排：恢复、保存和删除共用队列，始终读取最新历史，避免迟到写入复活已删除条目。 */
import type { CaptureDraft } from "../article/draft";
import type { CaptureHistoryStore } from "../article/history";
import { kernelPost } from "../siyuan/api";
import { clearAssetPins, localAssetReferences, stripPinAttributes, syncAssetPins, unreferencedAssets } from "./pins";

// 跨实例共享队列，避免重载期间旧恢复与新实例删除交错。失败不阻塞后续清理。
let pending: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.catch(() => undefined).then(operation);
  pending = result;
  return result;
}

/** 历史正文和当前草稿快照均是素材来源；不能只采集新文档正文。 */
function candidates(draft: CaptureDraft): string[] {
  const editor = draft.editorState;
  return localAssetReferences([draft.markdown, draft.article?.markdown || "", draft.reviewedMarkdown,
    editor?.markdown || "", editor?.nativeMarkdown || "", editor?.blockDOM || "", editor?.fullBlockDOM || "",
    ...draft.imageDecisions.flatMap(image => [image.full, image.url, image.previewUrl || ""])].join("\n"));
}

export class MaterialAssetPins {
  constructor(private readonly history: CaptureHistoryStore, private readonly inactive: () => boolean) {}

  /** 在队列内读取正文和关联条目，并在异步提交前再次检查条目仍属于该文档。 */
  private async syncDocument(documentId: string): Promise<void> {
    if (!documentId || this.inactive()) return;
    const saved = await kernelPost<{ kramdown: string }>("/api/block/getBlockKramdown", { id: documentId });
    const body = stripPinAttributes(saved.kramdown);
    for (const entry of this.history.entries.filter(item => item.draft.savedDocumentId === documentId)) {
      const current = (): boolean => !this.inactive() && this.history.entries.some(item => item.id === entry.id && item.draft.savedDocumentId === documentId);
      if (!current()) continue;
      await syncAssetPins(documentId, entry.id, unreferencedAssets(body, candidates(entry.draft)), { shouldWrite: current });
    }
  }

  /** 新文档保护成功后才释放旧文档上的本条目绑定，其他历史不受影响。 */
  saved(documentId: string, entryId: string, previousDocumentId: string): Promise<void> {
    return serial(async () => {
      await this.syncDocument(documentId);
      if (previousDocumentId && previousDocumentId !== documentId && !this.inactive()) {
        await clearAssetPins(previousDocumentId, entryId);
      }
    });
  }

  restore(): Promise<void> {
    return serial(async () => {
      const documents = new Set(this.history.entries.map(entry => entry.draft.savedDocumentId).filter(Boolean));
      for (const documentId of documents) {
        try { await this.syncDocument(documentId); }
        catch { /* 文档已删除或内核不可用：保留历史，稍后重试。 */ }
      }
    });
  }

  remove(documentId: string, entryId: string): Promise<void> {
    return serial(async () => { if (!this.inactive()) await clearAssetPins(documentId, entryId); });
  }
}

/** 自动保留工作台草稿；串行写入思源，并用同步缓存保护突然关闭的窗口。 */
import type { Article } from "../types";
import type { ImageDecision } from "../review/images";

export const DRAFT_STORAGE_NAME = "capture-draft.json";
const RECOVERY_KEY = "noosphere:capture-draft:v1";

/** 思源插件存储在网络异常时可能不返回回调，避免挂起整个工作台。 */
export async function storageTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("思源草稿存储请求超时")), 8000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export interface CaptureDraft {
  version: 1;
  updatedAt: number;
  url: string;
  article: Article | null;
  markdown: string;
  reviewedMarkdown: string;
  imageDecisions: ImageDecision[];
  targetDocumentId: string;
  perspective: string;
  outputLanguage?: import("../review/language").OutputLanguage;
  savedDocumentId: string;
  /** 已导入的文档独立于本次选择；正文变化后允许再次保存，仍能打开此前导入的文档。 */
  savedContentChanged?: boolean;
  reviewInfo?: { summary: string; completedAt: string; model: string; perspective: string };
  textReviewed?: boolean;
  historyId?: string;
  /** 原生编辑的块结构与 Markdown 一起保存，颜色、块属性和引用不会因恢复而丢失。 */
  editorState?: ArticleEditorState;
  bodyEdited?: boolean;
}

export interface ArticleEditorState { markdown: string; nativeMarkdown: string; blockDOM: string; fullBlockDOM?: string }

/** 本次审阅开始前的临时快照，仅供进行中取消时恢复，不随草稿保存。 */
export type ReviewSnapshot = Pick<CaptureDraft, "article" | "markdown" | "reviewedMarkdown" | "imageDecisions" | "reviewInfo" | "textReviewed" | "savedDocumentId" | "savedContentChanged" | "editorState" | "bodyEdited">;

/** 忽略损坏或不兼容的文件，避免恢复过程阻止工作台打开。 */
export function validDraft(value: unknown): value is CaptureDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as CaptureDraft;
  return draft.version === 1 && Number.isFinite(draft.updatedAt)
    && [draft.url, draft.markdown, draft.reviewedMarkdown, draft.targetDocumentId, draft.perspective, draft.savedDocumentId].every(item => typeof item === "string")
    && Array.isArray(draft.imageDecisions)
    && (!draft.reviewInfo || [draft.reviewInfo.summary, draft.reviewInfo.completedAt, draft.reviewInfo.model, draft.reviewInfo.perspective].every(item => typeof item === "string"))
    && (draft.textReviewed === undefined || typeof draft.textReviewed === "boolean")
    && (draft.historyId === undefined || typeof draft.historyId === "string")
    && (draft.bodyEdited === undefined || typeof draft.bodyEdited === "boolean")
    && (draft.savedContentChanged === undefined || typeof draft.savedContentChanged === "boolean")
    && (!draft.editorState || [draft.editorState.markdown, draft.editorState.nativeMarkdown, draft.editorState.blockDOM].every(item => typeof item === "string"))
    && (!draft.editorState || draft.editorState.fullBlockDOM === undefined || typeof draft.editorState.fullBlockDOM === "string")
    && (draft.outputLanguage === undefined || ["follow_ui", "source", "zh-CN", "en-US"].includes(draft.outputLanguage))
    && draft.imageDecisions.every(item => item && [item.full, item.alt, item.url, item.description].every(text => typeof text === "string") && typeof item.remove === "boolean" && typeof item.recommendedRemove === "boolean")
    && (draft.article === null || (!!draft.article && [draft.article.url, draft.article.title, draft.article.markdown].every(item => typeof item === "string")));
}

/** 时间戳不代表内容变化；用于合并重复关闭、完成和进度快照。 */
export function draftContentKey(draft: CaptureDraft): string {
  const { updatedAt: _timestamp, ...content } = draft;
  return JSON.stringify(content);
}

export class CaptureDraftStore {
  current: CaptureDraft | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;
  private revision = 0;
  private persistedRevision = 0;
  private timerDue = 0;

  constructor(
    private readonly read: () => Promise<unknown>,
    private readonly write: (draft: CaptureDraft) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly recovery?: Storage,
    private readonly workspaceId = "",
  ) {}

  async load(): Promise<void> {
    let stored: unknown;
    try { stored = await storageTimeout(this.read()); } catch (error) { this.onError(error); }
    let cached: unknown;
    try { cached = JSON.parse(this.recovery?.getItem(`${RECOVERY_KEY}:${this.workspaceId}`) || "null"); } catch { /* 缓存不可用时使用思源文件。 */ }
    this.current = validDraft(stored) ? stored : null;
    if (validDraft(cached) && (!this.current || cached.updatedAt > this.current.updatedAt)) {
      this.current = cached;
      this.revision++;
    }
  }

  /** 立即更新恢复缓存，合并连续输入，避免每个按键都写入思源文件。 */
  update(draft: CaptureDraft, delayMs = 250): void {
    if (this.disposed) return;
    if (this.current && draftContentKey(this.current) === draftContentKey(draft)) return;
    const previousTimestamp = this.current?.updatedAt || 0;
    this.current = JSON.parse(JSON.stringify(draft)) as CaptureDraft;
    this.current.updatedAt = Math.max(draft.updatedAt, previousTimestamp + 1);
    this.revision++;
    try { this.recovery?.setItem(`${RECOVERY_KEY}:${this.workspaceId}`, JSON.stringify(this.current)); } catch { /* 思源持久化仍会执行。 */ }
    // 图片进度立即进入恢复缓存，每五秒合并写盘；普通编辑继续短防抖。
    const due = Date.now() + delayMs;
    if (delayMs > 250 && this.timer && this.timerDue <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(() => { void this.flush().catch(this.onError); }, delayMs);
  }

  /** 关闭窗口及完成抓取时立即写入；排队保证旧请求不会覆盖新正文。 */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return Promise.resolve();
    if (!this.current) return this.pending;
    const revision = this.revision;
    if (revision <= this.persistedRevision) return storageTimeout(this.pending);
    const snapshot = JSON.parse(JSON.stringify(this.current)) as CaptureDraft;
    // 超时只结束调用方等待，底层写入仍保持串行，防止慢请求后来覆盖新草稿。
    this.pending = this.pending.catch(() => undefined).then(async () => {
      if (this.disposed || revision <= this.persistedRevision) return;
      await this.write(snapshot);
      this.persistedRevision = revision;
    });
    return storageTimeout(this.pending);
  }

  /** 真正卸载时立即停用恢复缓存及排队写入，防止关闭回调重新保存草稿。 */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.current = null;
    this.recovery?.removeItem(`${RECOVERY_KEY}:${this.workspaceId}`);
    this.recovery?.removeItem(RECOVERY_KEY);
  }
}

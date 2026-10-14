/** 文章历史与当前草稿分开保存；删除历史不会删除已导入的思源笔记。 */
import { draftContentKey, storageTimeout, validDraft, type CaptureDraft } from "./draft";
import { restoreArticleTime } from "./time";

export const HISTORY_STORAGE_NAME = "capture-history.json";
const RECOVERY_KEY = "noosphere:capture-history:v1";

export interface CaptureHistoryEntry { id: string; capturedAt: number; draft: CaptureDraft }
export interface CaptureHistory { version: 1; updatedAt: number; entries: CaptureHistoryEntry[] }

/** 单条损坏记录不影响其他文章读取，兼容早期单篇草稿。 */
function readHistory(value: unknown): CaptureHistory | null {
  if (!value || typeof value !== "object") return null;
  const history = value as CaptureHistory;
  if (history.version !== 1 || !Number.isFinite(history.updatedAt) || !Array.isArray(history.entries)) return null;
  const ids = new Set<string>();
  const entries = history.entries.filter(entry => {
    if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
      || !Number.isFinite(entry.capturedAt) || !validDraft(entry.draft) || !entry.draft.article) return false;
    ids.add(entry.id);
    return true;
  });
  return { ...history, entries: entries.map(entry => ({ ...entry,
    draft: { ...entry.draft, article: restoreArticleTime(entry.draft.article!, entry.capturedAt) } })) };
}

export class CaptureHistoryStore {
  private state: CaptureHistory = { version: 1, updatedAt: 0, entries: [] };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;
  private revision = 0;
  private persistedRevision = 0;
  private timerDue = 0;

  constructor(
    private readonly read: () => Promise<unknown>,
    private readonly write: (history: CaptureHistory) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly recovery?: Storage,
    private readonly workspaceId = "",
  ) {}

  get entries(): readonly CaptureHistoryEntry[] { return this.state.entries; }

  async load(): Promise<void> {
    let stored: CaptureHistory | null = null, cached: CaptureHistory | null = null;
    try { stored = readHistory(await storageTimeout(this.read())); } catch (error) { this.onError(error); }
    try { cached = readHistory(JSON.parse(this.recovery?.getItem(`${RECOVERY_KEY}:${this.workspaceId}`) || "null")); } catch { /* 缓存不可用时读思源文件。 */ }
    this.state = cached && (!stored || cached.updatedAt > stored.updatedAt) ? cached : stored || this.state;
    if (this.state === cached) this.revision++;
  }

  /** 每次成功抓取创建独立记录，同链接再次抓取也保留此前版本。 */
  add(draft: CaptureDraft): string {
    if (this.disposed || !draft.article) return "";
    // Docker 的 HTTP 浏览器前端可能没有 randomUUID，仍需正常抓取和保留历史。
    const id = globalThis.crypto?.randomUUID?.() || `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const capturedAt = Date.parse(draft.article.capturedAt || "") || Date.now();
    const snapshot = structuredClone({ ...draft, article: restoreArticleTime(draft.article, capturedAt), historyId: id });
    this.state.entries.unshift({ id, capturedAt, draft: snapshot });
    this.changed();
    return id;
  }

  /** 修改已有记录；删除后到达的异步回调不能重新创建记录。 */
  update(id: string, draft: CaptureDraft, delayMs = 250): void {
    if (this.disposed || !draft.article) return;
    const entry = this.state.entries.find(item => item.id === id);
    if (!entry) return;
    const next = { ...draft, historyId: id };
    if (draftContentKey(entry.draft) === draftContentKey(next)) return;
    entry.draft = structuredClone(next);
    this.changed(delayMs);
  }

  remove(id: string): void {
    if (this.disposed) return;
    if (!this.state.entries.some(entry => entry.id === id)) return;
    this.state.entries = this.state.entries.filter(entry => entry.id !== id);
    this.changed();
  }

  /** 将升级前的单篇草稿加入历史，避免重启重复迁移。 */
  migrate(draft: CaptureDraft | null): string | undefined {
    if (!draft?.article) return undefined;
    if (draft.historyId) return this.state.entries.some(entry => entry.id === draft.historyId) ? draft.historyId : undefined;
    const existing = this.state.entries.find(entry => entry.draft.article?.url === draft.article?.url
      && entry.draft.article?.capturedAt === draft.article?.capturedAt && entry.draft.article?.markdown === draft.article?.markdown);
    return existing?.id || this.add(draft);
  }

  private changed(delayMs = 250): void {
    this.state.updatedAt = Math.max(Date.now(), this.state.updatedAt + 1);
    this.revision++;
    try { this.recovery?.setItem(`${RECOVERY_KEY}:${this.workspaceId}`, JSON.stringify(this.state)); } catch { /* 仍会持久化到思源。 */ }
    // 进度更新保留首次定时点，长文持续更新时仍定期写盘，不等整轮结束。
    const due = Date.now() + delayMs;
    if (delayMs > 250 && this.timer && this.timerDue <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(() => { void this.flush().catch(this.onError); }, delayMs);
  }

  /** 写入严格串行；旧保存完成后再写入删除，防止文章重新出现。 */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return Promise.resolve();
    const revision = this.revision;
    if (revision <= this.persistedRevision) return storageTimeout(this.pending);
    const snapshot = structuredClone(this.state);
    this.pending = this.pending.catch(() => undefined).then(async () => {
      if (this.disposed || revision <= this.persistedRevision) return;
      await this.write(snapshot);
      this.persistedRevision = revision;
    });
    return storageTimeout(this.pending);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.state = { version: 1, updatedAt: 0, entries: [] };
    this.recovery?.removeItem(`${RECOVERY_KEY}:${this.workspaceId}`);
  }
}

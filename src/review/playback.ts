/** 根据文章长度、生成时长和到达速度平滑输出，持续追赶短缓冲，不在结束时批量补字。 */
export class ReviewTextPlayback {
  private readonly segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  private units: string[] = [];
  private shown = 0;
  private position = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private paused = false;
  private deadline = 0;
  private lastFrame = 0;
  private readonly startedAt = Date.now();
  private lastArrival = this.startedAt;
  private arrivalRate = 0;
  private burstAt: number | undefined;
  private readonly intervals: number[] = [];
  private bodyComplete = false;
  private ending = false;
  private failure: unknown;
  private done: Promise<void> | undefined;
  private resolveDone: (() => void) | undefined;
  private rejectDone: ((error: unknown) => void) | undefined;
  private readonly abort = (): void => this.stop();

  constructor(private readonly render: (text: string, count: number) => void, private readonly signal?: AbortSignal, private readonly expectedCharacters = 0) {
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.stop();
  }

  get hasText(): boolean { return this.units.length > 0; }
  get pending(): boolean { return !this.stopped && this.shown < this.units.length; }
  get count(): number { return this.shown; }
  get active(): boolean { return !this.stopped && this.hasText; }
  get bodyFinished(): boolean { return this.bodyComplete; }

  /** 包括思考/心跳在内的原始网络到达时间，用于在正文开始前识别成批转发的节奏。 */
  observeArrival(): void {
    const now = Date.now();
    if (this.burstAt === undefined) { this.burstAt = now; return; }
    const gap = now - this.burstAt;
    if (gap < 120) return;
    if (gap <= 10000) { this.intervals.push(gap); if (this.intervals.length > 5) this.intervals.shift(); }
    this.burstAt = now;
  }

  /** 正文字段闭合时及时收敛显示余量；内部摘要和图片处理仍由模型继续完成。 */
  markBodyComplete(): void {
    if (this.bodyComplete) return;
    this.bodyComplete = true;
    if (this.pending) this.deadline = Math.min(this.deadline, Date.now() + 160);
  }

  /** 按 Unicode 字素分段，表情和组合字符不会被拆开；校验后的正文修正只回退到差异处。 */
  update(text: string): void {
    if (this.stopped || this.failure) return;
    const next = Array.from(this.segmenter.segment(text), part => part.segment);
    let shared = 0;
    while (shared < this.shown && shared < next.length && this.units[shared] === next[shared]) shared++;
    const added = Math.max(0, next.length - this.units.length);
    const changed = this.units.length !== next.length || shared < this.shown;
    // 校验后补回图片或调整空白时，已显示的文字不倒退后再吐一遍。
    let rebased = shared;
    if (shared < this.shown) {
      const meaningful = (unit: string): boolean => !/^[\s\uFFFC]+$/u.test(unit);
      const before = this.units.slice(0, this.shown).filter(meaningful);
      const after = next.filter(meaningful);
      if (before.length && before.every((unit, i) => unit === after[i])) {
        let visible = 0, index = 0;
        while (index < next.length && visible < before.length) if (meaningful(next[index++])) visible++;
        rebased = index;
        if (this.shown === this.units.length && before.length === after.length) rebased = next.length;
      }
    }
    this.units = next;
    if (shared < this.shown) { this.shown = this.position = rebased; this.emit(); }
    if (changed) {
      const now = Date.now();
      if (added) {
        const rate = added * 1000 / Math.max(this.arrivalRate ? 16 : 64, now - this.lastArrival);
        this.arrivalRate = this.arrivalRate ? this.arrivalRate * 0.6 + rate * 0.4 : rate;
        this.lastArrival = now;
      }
      // 批量到达时把文字均匀铺到下一批之前；细粒度流继续使用短缓冲。
      const lengthRate = Math.max(this.expectedCharacters, next.length) * 1000 / Math.max(1000, now - this.startedAt);
      const rate = Math.max(this.arrivalRate, Math.min(lengthRate, this.arrivalRate * 1.25));
      const normalWindow = Math.min(160, Math.max(64, added * 1000 / Math.max(1, rate)));
      const cadenceWindow = this.intervals.length ? Math.min(3500, Math.max(...this.intervals) * 1.03) : normalWindow;
      if (this.bodyComplete) this.deadline = now + normalWindow;
      else this.deadline = Math.max(this.deadline, (this.burstAt ?? now) + Math.max(normalWindow, cadenceWindow));
    }
    if (!this.timer) this.lastFrame = Date.now();
    this.schedule();
  }

  /** 结束前后使用同一套速度；小量尾字继续按帧显示，最后一帧才通知完成。 */
  finish(): Promise<void> {
    this.ending = true;
    this.markBodyComplete();
    this.done ||= new Promise<void>((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    if (this.failure) this.rejectDone?.(this.failure);
    else if (this.stopped || this.paused || !this.pending) this.resolveDone?.();
    else this.schedule();
    return this.done;
  }

  /** 关闭窗口只暂停画面；模型请求独立运行，重新打开后继续显示。 */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.clearTimer();
    else { this.lastFrame = Date.now(); this.deadline = this.lastFrame + 64; this.schedule(); }
    if (paused && this.ending) this.resolveDone?.();
  }

  /** 取消或卸载后清除计时器，迟到的数据不能继续改写预览。 */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.signal?.removeEventListener("abort", this.abort);
    this.resolveDone?.();
  }

  private schedule(): void {
    if (this.timer || !this.pending || this.failure || this.paused) return;
    // 每帧按积压量追赶短缓冲；高速生成可推进多字，避免固定字速拖慢长文。
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.pending) return;
      const now = Date.now();
      const elapsed = Math.max(1, now - this.lastFrame);
      const remaining = this.units.length - this.position;
      const fraction = Math.min(1, elapsed / Math.max(1, this.deadline - this.lastFrame));
      this.position += remaining * fraction;
      this.lastFrame = now;
      const shown = Math.floor(this.position + 1e-6);
      if (shown !== this.shown) { this.shown = shown; this.emit(); }
      if (!this.pending && this.ending) this.resolveDone?.();
      else this.schedule();
    }, 16);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emit(): void {
    try { this.render(this.units.slice(0, this.shown).join(""), this.shown); }
    catch (error) { this.failure = error; this.rejectDone?.(error); this.stop(); }
  }
}

/** 系统来源行不参与逐字输出，正文使用校验后的最终内容补齐队列。 */
export function reviewPlaybackContent(markdown: string, fallbackTitle: string): { title: string; markdown: string } {
  const heading = markdown.match(/^#{1,6}\s+([^\n]+)\n+/);
  let body = heading ? markdown.slice(heading[0].length).trim() : markdown.trim();
  body = body.replace(/^> 来源：<[^\n]+(?:\n|$)\s*/, "").trim();
  return { title: heading?.[1] || fallbackTitle, markdown: body };
}

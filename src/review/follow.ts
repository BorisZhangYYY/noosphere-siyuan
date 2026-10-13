/** 连续跟随新增正文与图片高度，避免每帧直接跳到最底部。 */
export class StreamFollowScroll {
  private enabled = false;
  private stopped = false;
  private finishing = false;
  private cancelFrame: (() => void) | undefined;
  private lastFrame = 0;
  private readonly observer?: ResizeObserver;

  constructor(private readonly scroll: HTMLElement, content: HTMLElement) {
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.follow());
      this.observer.observe(content);
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled && !this.stopped) { this.scroll.dataset.streamFollowing = "true"; this.follow(); }
    else { this.cancelFrame?.(); this.cancelFrame = undefined; delete this.scroll.dataset.streamFollowing; }
  }

  /** 正文每帧与图片加载都可更新目标，动画始终追赶最新高度。 */
  follow(): void {
    if (!this.enabled || this.stopped || this.cancelFrame) return;
    this.lastFrame = Date.now(); this.schedule();
  }

  stop(): void {
    this.stopped = true; this.setEnabled(false); this.observer?.disconnect();
  }

  /** 结束时继续平滑移动到最后一行，再释放观察与动画，不把最后一行留在视口下方。 */
  finish(): void {
    this.finishing = true;
    if (this.enabled) this.follow(); else this.stop();
  }

  private schedule(): void {
    const step = (): void => {
      this.cancelFrame = undefined;
      if (!this.enabled || this.stopped) return;
      const target = Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
      const distance = target - this.scroll.scrollTop;
      const now = Date.now();
      const fraction = 1 - Math.exp(-Math.min(48, Math.max(1, now - this.lastFrame)) / 80);
      this.lastFrame = now;
      this.scroll.scrollTop += Math.abs(distance) < 0.5 ? distance : distance * fraction;
      if (Math.abs(target - this.scroll.scrollTop) >= 0.5) this.schedule();
      else if (this.finishing) this.stop();
    };
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(step); this.cancelFrame = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(step, 16); this.cancelFrame = () => clearTimeout(timer);
    }
  }
}

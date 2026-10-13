// @vitest-environment jsdom
/** 正文增长与大图加载时连续跟随，暂停、关闭后不再移动阅读位置。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamFollowScroll } from "../src/review/follow";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function surface(): { scroll: HTMLElement; content: HTMLElement; grow: (height: number) => void } {
  const scroll = document.createElement("div"), content = document.createElement("article");
  let height = 300;
  Object.defineProperties(scroll, { scrollHeight: { get: () => height }, clientHeight: { value: 300 } });
  return { scroll, content, grow: next => { height = next; } };
}

describe("stream follow scroll", () => {
  it("moves through intermediate positions when a large image increases the article height", async () => {
    const { scroll, content, grow } = surface(); const follow = new StreamFollowScroll(scroll, content);
    grow(1500); follow.setEnabled(true); await vi.advanceTimersByTimeAsync(16);
    expect(scroll.scrollTop).toBeGreaterThan(0); expect(scroll.scrollTop).toBeLessThan(300);
    const first = scroll.scrollTop; await vi.advanceTimersByTimeAsync(16);
    expect(scroll.scrollTop).toBeGreaterThan(first); expect(scroll.scrollTop).toBeLessThan(1200);
    grow(1800); follow.follow(); await vi.advanceTimersByTimeAsync(1000);
    expect(scroll.scrollTop).toBeCloseTo(1500, 0); follow.stop();
  });

  it("keeps the user's reading position after pausing or closing", async () => {
    const { scroll, content, grow } = surface(); const follow = new StreamFollowScroll(scroll, content);
    grow(1500); follow.setEnabled(true); await vi.advanceTimersByTimeAsync(32);
    follow.setEnabled(false); const paused = scroll.scrollTop; grow(2000); follow.follow();
    await vi.advanceTimersByTimeAsync(1000); expect(scroll.scrollTop).toBe(paused);
    follow.setEnabled(true); await vi.advanceTimersByTimeAsync(32); expect(scroll.scrollTop).toBeGreaterThan(paused);
    follow.stop(); const stopped = scroll.scrollTop; grow(2500); follow.setEnabled(true);
    await vi.advanceTimersByTimeAsync(1000); expect(scroll.scrollTop).toBe(stopped); expect(vi.getTimerCount()).toBe(0);
  });

  it("reaches the last line smoothly before releasing the completed follower", async () => {
    const { scroll, content, grow } = surface(); const follow = new StreamFollowScroll(scroll, content);
    grow(1500); follow.setEnabled(true); await vi.advanceTimersByTimeAsync(32); follow.finish();
    expect(scroll.scrollTop).toBeLessThan(1200); await vi.advanceTimersByTimeAsync(1000);
    expect(scroll.scrollTop).toBeCloseTo(1200, 0); expect(vi.getTimerCount()).toBe(0);
  });
});

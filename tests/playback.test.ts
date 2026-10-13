/** 动态吐字速度、Unicode 边界、末尾平滑显示与后台暂停。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewTextPlayback, reviewPlaybackContent } from "../src/review/playback";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("review text playback", () => {
  it("smooths a burst across frames and never dumps the tail when finish is called", async () => {
    const frames: string[] = []; const playback = new ReviewTextPlayback(text => frames.push(text));
    playback.update("一二三四五六七八九十");
    await vi.advanceTimersByTimeAsync(16);
    expect(frames).toEqual(["一二"]);
    let complete = false; const finished = playback.finish().then(() => { complete = true; });
    expect(frames).toHaveLength(1); expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(48); await finished;
    expect(frames.at(-1)).toBe("一二三四五六七八九十"); expect(frames.length).toBeGreaterThan(2);
    expect(complete).toBe(true); playback.stop();
  });

  it.each([7000, 1800000])("keeps pace throughout a %i ms generation instead of accumulating a slow queue", async duration => {
    const frames: Array<{ at: number; count: number }> = []; const start = Date.now();
    const playback = new ReviewTextPlayback((_text, count) => frames.push({ at: Date.now() - start, count }), undefined, 12000);
    let body = "";
    for (let step = 0; step < 100; step++) {
      body += "正在生成的完整正文。".repeat(4);
      playback.update(body);
      await vi.advanceTimersByTimeAsync(duration / 100);
      expect(playback.count).toBe(Array.from(body).length);
    }
    const before = frames.length;
    await playback.finish();
    expect(frames).toHaveLength(before); expect(Date.now() - start).toBe(duration);
    expect(frames.length).toBeGreaterThan(100); expect(Math.max(...frames.map((frame, i) => frame.count - (frames[i - 1]?.count || 0)))).toBeLessThan(40);
    playback.stop();
  });

  it("accelerates with faster incoming text without a fixed character speed", async () => {
    const playback = new ReviewTextPlayback(() => undefined, undefined, 10000);
    playback.update("字".repeat(20)); await vi.advanceTimersByTimeAsync(64); expect(playback.count).toBe(20);
    playback.update("字".repeat(220)); await vi.advanceTimersByTimeAsync(64); expect(playback.count).toBeGreaterThan(100);
    await vi.advanceTimersByTimeAsync(96); expect(playback.count).toBe(220);
    playback.stop();
  });

  it("bridges regular two-second network batches with continuous frames rather than emptying each burst immediately", async () => {
    const frames: Array<{ at: number; count: number }> = [];
    const playback = new ReviewTextPlayback((_text, count) => frames.push({ at: Date.now(), count }));
    playback.observeArrival(); await vi.advanceTimersByTimeAsync(2000); playback.observeArrival();
    let body = "";
    for (let batch = 0; batch < 4; batch++) {
      body += "字".repeat(200); playback.update(body);
      await vi.advanceTimersByTimeAsync(2000); playback.observeArrival();
    }
    const advancing = frames.filter((frame, i) => frame.count > (frames[i - 1]?.count || 0));
    expect(advancing.length).toBeGreaterThan(400);
    expect(Math.max(...advancing.slice(1).map((frame, i) => frame.at - advancing[i].at))).toBeLessThanOrEqual(32);
    playback.markBodyComplete(); const finished = playback.finish(); await vi.advanceTimersByTimeAsync(160); await finished;
    expect(playback.count).toBe(800); playback.stop();
  });

  it("keeps emoji sequences and combining characters intact across chunks", async () => {
    const frames: string[] = []; const playback = new ReviewTextPlayback(text => frames.push(text));
    playback.update("👨‍👩‍👧‍👦e\u0301"); await vi.advanceTimersByTimeAsync(16);
    playback.update("👨‍👩‍👧‍👦e\u0301好"); const finished = playback.finish();
    await vi.advanceTimersByTimeAsync(64); await finished;
    expect(frames).toEqual(["👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦e\u0301", "👨‍👩‍👧‍👦e\u0301好"]); playback.stop();
  });

  it("pauses only presentation and resumes the same text queue", async () => {
    const render = vi.fn(); const playback = new ReviewTextPlayback(render);
    playback.update("后台继续生成"); playback.setPaused(true); await vi.advanceTimersByTimeAsync(60000);
    expect(render).not.toHaveBeenCalled(); playback.update("后台继续生成并完成"); playback.setPaused(false);
    await vi.advanceTimersByTimeAsync(64); expect(render).toHaveBeenLastCalledWith("后台继续生成并完成", 9);
    playback.stop();
  });

  it("stops immediately on abort and ignores later chunks", async () => {
    const render = vi.fn(); const controller = new AbortController(); const playback = new ReviewTextPlayback(render, controller.signal);
    playback.update("未完成的正文"); await vi.advanceTimersByTimeAsync(16);
    const finished = playback.finish(); controller.abort(); await finished;
    playback.update("迟到的全文"); await vi.runAllTimersAsync(); expect(render).toHaveBeenCalledOnce();
  });

  it("propagates display failures to the review instead of completing", async () => {
    const playback = new ReviewTextPlayback(() => { throw new Error("render failed"); });
    playback.update("正文"); const assertion = expect(playback.finish()).rejects.toThrow("render failed");
    await vi.advanceTimersByTimeAsync(64); await assertion;
  });

  it("does not retype already displayed words when validated results restore images and spacing", async () => {
    const frames: string[] = []; const playback = new ReviewTextPlayback(text => frames.push(text));
    playback.update("正文\n参考链接"); await vi.advanceTimersByTimeAsync(160);
    playback.update("正文 ￼\n\n参考链接\n￼");
    expect(playback.pending).toBe(false); expect(frames.at(-1)).toBe("正文 ￼\n\n参考链接\n￼");
    await playback.finish(); expect(frames.filter(text => text.includes("参考链接"))).toHaveLength(2); playback.stop();
  });

  it("separates the title and system source line from the generated body", () => {
    expect(reviewPlaybackContent("# 标题\n\n> 来源：<https://example.com> · 作者：张三\n\n正文\n", "原标题")).toEqual({ title: "标题", markdown: "正文" });
    expect(reviewPlaybackContent("处理稿", "原标题")).toEqual({ title: "原标题", markdown: "处理稿" });
  });
});

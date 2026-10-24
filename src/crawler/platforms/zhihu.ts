/** 知乎结果校验：访问受限页面不能进入文章历史或后续 AI 审阅。 */
import type { CaptureResult, PlatformPolicy } from "./types";

/** 沿用原版的短访问页识别；长文章引用登录提示时仍保留正文。 */
function validateCapture(capture: CaptureResult): void {
  const prose = capture.markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s/g, "");
  const markers = ["请您登录后查看更多专业优质内容", "登录后查看全文", "登录后阅读全文", "注册或登录知乎", "安全验证", "请求异常", "访问过于频繁"];
  if ([401, 403, 429].includes(capture.statusCode ?? 0) || (prose.length < 800 && markers.some(marker => prose.includes(marker)))) {
    throw new Error("知乎未返回文章正文：页面要求登录、安全验证或访问受限，请检查原文访问情况。");
  }
}

export const zhihu: PlatformPolicy = {
  sourceName: "知乎",
  matches: (url: URL): boolean => /(^|\.)zhihu\.com$/.test(url.hostname),
  validateCapture,
};

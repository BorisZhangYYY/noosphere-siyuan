/** 供应商思考输出兼容：只读取公开返回的字段，将其与审阅正文分开。 */
import type { Settings } from "../types";

/** 心跳只能证明连接活动；只有实际思考或正文增量才延长生成等待期限。 */
export type ModelActivity = "thinking" | "text" | "heartbeat" | "waiting";

/** MiniMax 官方允许显式分离思考字段；不能把此扩展参数发送给其他服务。 */
export function reasoningRequestOptions(settings: Settings): { reasoning_split?: true } {
  if (settings.modelFormat !== "openai_chat") return {};
  let minimax = settings.activeProvider === "minimax";
  try { minimax ||= /(?:^|\.)minimax(?:i\.com|\.cn|\.io|\.chat)$/.test(new URL(settings.modelBaseUrl).hostname); }
  catch { /* 地址校验由请求入口提供，不在这里改写用户配置。 */ }
  return minimax ? { reasoning_split: true } : {};
}

/** 仅识别输出前缀中的 <think> 块；JSON 正文内部的同名标签必须原样保留。 */
export class ThinkingContentFilter {
  private mode: "prefix" | "thinking" | "body" = "prefix";
  private buffer = "";
  constructor(private readonly onText: (text: string) => void, private readonly onThinking: (text: string) => void) {}

  /** 标签和 UTF-8 解码后的文本可以跨任意 SSE 增量切分。 */
  push(text: string): void {
    if (!text) return;
    if (this.mode === "body") { this.onText(text); return; }
    this.buffer += text;
    while (this.buffer) {
      if (this.mode === "prefix") {
        const prefix = this.buffer.trimStart();
        if (!prefix || prefix.length < 7 && "<think>".startsWith(prefix)) return;
        if (prefix.startsWith("<think>")) { this.buffer = prefix.slice(7); this.mode = "thinking"; continue; }
        this.mode = "body"; this.onText(this.buffer); this.buffer = ""; return;
      }
      const end = this.buffer.indexOf("</think>");
      if (end >= 0) {
        this.onThinking(this.buffer.slice(0, end)); this.buffer = this.buffer.slice(end + 8); this.mode = "prefix"; continue;
      }
      // 留下可能属于结束标签的短后缀，不能把半个标签误报为思考文字。
      let pending = Math.min(7, this.buffer.length);
      while (pending && !"</think>".startsWith(this.buffer.slice(-pending))) pending--;
      const ready = this.buffer.slice(0, this.buffer.length - pending);
      if (ready) this.onThinking(ready);
      this.buffer = pending ? this.buffer.slice(-pending) : "";
      return;
    }
  }

  finish(): void {
    if (this.mode === "thinking") throw new Error("模型思考输出未完成，尚未收到完整正文；原稿已保留");
    if (this.buffer) { this.onText(this.buffer); this.buffer = ""; }
  }
}

/** 普通 JSON、分类、引用补丁和识图同样不能把思考前缀交给正文解析器。 */
export function chatResponseContent(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => part.text || "").join("\n") : "";
  let body = "";
  const filter = new ThinkingContentFilter(chunk => { body += chunk; }, () => undefined);
  filter.push(text); filter.finish();
  return body;
}

/** SSE 分帧与模型协议增量解析；只在收到完成事件后接受最终审阅稿。 */
import type { Settings } from "../types";

export interface ServerEvent { event: string; data: string }

export class EventStreamParser {
  private buffer = "";
  constructor(private readonly accept: (event: ServerEvent) => void) {}

  /** 支持任意分包、CRLF 与多行 data；网络结束时处理最后一个事件。 */
  push(chunk: string, final = false): void {
    this.buffer += chunk;
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      this.frame(frame);
    }
    if (final && this.buffer.trim()) { this.frame(this.buffer); this.buffer = ""; }
  }

  private frame(frame: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) this.accept({ event, data: data.join("\n") });
  }
}

interface ModelEvent {
  type?: string;
  error?: { message?: string } | string;
  message?: string;
  delta?: string | { type?: string; text?: string; stop_reason?: string };
  content_block?: { type?: string; text?: string };
  response?: { status?: string; incomplete_details?: { reason?: string }; error?: { message?: string }; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  choices?: Array<{ index?: number; finish_reason?: string; delta?: { content?: string }; message?: { content?: string } }>;
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
}

export class ModelReviewStream {
  text = "";
  private completed = false;
  private stopReason = "";
  private events = 0;
  readonly parser = new EventStreamParser(event => this.accept(event));

  constructor(private readonly format: Settings["modelFormat"], private readonly onText: (text: string) => void) {}

  private append(delta: string | undefined): void {
    if (!delta) return;
    this.text += delta;
    this.onText(this.text);
  }

  private accept({ event, data }: ServerEvent): void {
    this.events++;
    if (data.trim() === "[DONE]") { if (this.format === "openai_chat") this.completed = true; return; }
    let result: ModelEvent;
    try { result = JSON.parse(data) as ModelEvent; }
    catch { throw new Error("模型流式响应格式无效；原稿已保留。"); }
    if (!result || typeof result !== "object") throw new Error("模型流式响应无效；原稿已保留。");
    const type = result.type || event;
    if (result.error || type === "error") throw new Error(typeof result.error === "string" ? result.error : result.error?.message || result.message || "模型流式审阅失败");
    if (this.format === "anthropic") {
      if (type === "content_block_start" && result.content_block?.type === "text") this.append(result.content_block.text);
      if (type === "content_block_delta" && typeof result.delta === "object" && result.delta.type === "text_delta") this.append(result.delta.text);
      if (type === "message_delta" && typeof result.delta === "object") this.stopReason = result.delta.stop_reason || this.stopReason;
      if (type === "message_stop") this.completed = true;
    } else if (this.format === "openai_responses") {
      if (type === "response.output_text.delta" && typeof result.delta === "string") this.append(result.delta);
      if (["response.failed", "response.incomplete", "response.cancelled"].includes(type)) {
        this.stopReason = result.response?.incomplete_details?.reason || result.response?.status || type;
        this.checkStop();
        throw new Error(`模型没有完成审阅（${this.stopReason}）；原稿已保留。`);
      }
      if (type === "response.completed") {
        if (!this.text) this.append(result.response?.output?.flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text || "").join("\n"));
        this.completed = true;
      }
    } else if (this.format === "google") {
      const candidate = result.candidates?.[0];
      this.append(candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || "").join(""));
      if (candidate?.finishReason) { this.stopReason = candidate.finishReason; this.completed = true; }
    } else {
      const choice = result.choices?.find(item => item.index === undefined || item.index === 0);
      this.append(choice?.delta?.content);
      if (choice?.finish_reason) { this.stopReason = choice.finish_reason; this.completed = true; }
    }
    this.checkStop();
  }

  private checkStop(): void {
    if (["max_tokens", "length", "MAX_TOKENS", "max_output_tokens", "model_context_window_exceeded"].includes(this.stopReason)) {
      throw new Error("模型输出达到长度上限，审阅结果被截断；原稿已保留。请减少单次审阅内容，或选择支持更长输出的模型。");
    }
    const successful = this.format === "anthropic" ? ["end_turn", "stop_sequence"] : this.format === "google" ? ["STOP"] : ["stop"];
    if (this.format !== "openai_responses" && this.stopReason && !successful.includes(this.stopReason)) throw new Error(`模型没有完成审阅（${this.stopReason}）；原稿已保留。`);
  }

  /** 返回 null 表示服务忽略流式参数，交给普通 JSON 响应解析。 */
  finish(): string | null {
    this.parser.push("", true);
    if (!this.events) return null;
    this.checkStop();
    if (!this.completed || !this.text.trim()) throw new Error("模型流式连接已中断，未收到完整审阅结果；原稿已保留，请重试。");
    return this.text;
  }
}

/** 只解析顶层 JSON 字符串字段；半个转义序列留待后续包补齐。 */
function partialString(source: string, start: number): { text: string; end: number; complete: boolean } {
  let text = "";
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '"') return { text, end: i + 1, complete: true };
    if (char !== "\\") { text += char; continue; }
    const escape = source[++i];
    if (escape === undefined) break;
    if (escape === "u") {
      const code = source.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(code)) break;
      text += String.fromCharCode(parseInt(code, 16)); i += 4;
    } else {
      const escaped: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
      if (!(escape in escaped)) break;
      text += escaped[escape];
    }
  }
  return { text: text.replace(/[\uD800-\uDBFF]$/, ""), end: source.length, complete: false };
}

/** 隐藏内部摘要与 JSON 语法，只提供尚在生成中的阅读预览。 */
export function partialReviewContent(source: string, onBodyComplete?: () => void): { title: string; markdown: string } {
  let depth = 0;
  const content = { title: "", markdown: "" };
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "{" || source[i] === "[") depth++;
    else if (source[i] === "}" || source[i] === "]") depth--;
    else if (source[i] === '"') {
      const key = partialString(source, i);
      i = key.end - 1;
      if (depth !== 1 || !key.complete || !["title", "markdown"].includes(key.text)) continue;
      const tail = source.slice(key.end).match(/^\s*:\s*"/);
      if (!tail) continue;
      const value = partialString(source, key.end + tail[0].length - 1);
      content[key.text as keyof typeof content] = value.text;
      if (key.text === "markdown" && value.complete) onBodyComplete?.();
      i = value.end - 1;
    }
  }
  return content;
}

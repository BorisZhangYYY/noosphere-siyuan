/** 审阅时仅向模型提供链接引用，真实地址由本次请求的本地映射持有。 */
import { partialReviewContent } from "./stream";

interface Destination { start: number; end: number; value: string }
export interface LockedReviewLinks {
  input: string;
  restoreResponse(response: string): string;
  preview(response: string): string | undefined;
}

/** 读取 Markdown 的链接目标，支持尖括号、转义与成对括号。 */
function destination(text: string, start: number): Destination | undefined {
  if (text[start] === "<") {
    const end = text.indexOf(">", start + 1);
    return end > start + 1 ? { start: start + 1, end, value: text.slice(start + 1, end) } : undefined;
  }
  let end = start, depth = 0;
  for (; end < text.length; end++) {
    const char = text[end];
    if (char === "\\" && end + 1 < text.length) { end++; continue; }
    if (/\s/.test(char)) break;
    if (char === "(") depth++;
    if (char === ")") { if (!depth) break; depth--; }
  }
  return end > start ? { start, end, value: text.slice(start, end) } : undefined;
}

/** 同一套规则覆盖图片、普通链接、引用式链接、HTML 属性及裸 HTTP 地址。 */
function destinations(text: string): Destination[] {
  const spans: Destination[] = [];
  for (const match of text.matchAll(/\]\([ \t]*|^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*/gm)) {
    const found = destination(text, match.index + match[0].length);
    if (found) spans.push(found);
  }
  for (const match of text.matchAll(/\b(?:href|src)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi)) {
    const value = match[2] ?? match[3];
    const start = match.index + (match[1] ? match[0].indexOf(match[1]) + 1 : match[0].length - value.length);
    spans.push({ start, end: start + value.length, value });
  }
  for (const match of text.matchAll(/<(?:https?:\/\/|mailto:|ftp:\/\/)[^>\n]+>/gi)) {
    spans.push({ start: match.index + 1, end: match.index + match[0].length - 1, value: match[0].slice(1, -1) });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    if (spans.some(span => match.index >= span.start && match.index < span.end)) continue;
    let value = match[0];
    // 裸地址外侧的 Markdown/行文括号不属于 URL；地址内部成对括号继续锁定。
    while (value.endsWith(")") && (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)) value = value.slice(0, -1);
    spans.push({ start: match.index, end: match.index + value.length, value });
  }
  const result: Destination[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (!result.length || span.start >= result[result.length - 1].end) result.push(span);
  }
  return result;
}

/** 映射仅在本次审阅内存中存在；编号损坏或未知地址使结果校验失败，原稿由流程保留。 */
export function lockReviewLinks(source: string): LockedReviewLinks {
  let prefix = "__NOOSPHERE_LINK_";
  while (source.includes(prefix)) prefix += "X_";
  const links = new Map<string, string>(), references = new Map<string, string>();
  const spans = destinations(source);
  let input = source;
  for (const span of [...spans].reverse()) {
    let reference = references.get(span.value);
    if (!reference) {
      reference = `${prefix}${links.size + 1}__`;
      references.set(span.value, reference); links.set(reference, span.value);
    }
    input = input.slice(0, span.start) + reference + input.slice(span.end);
  }
  const invalid = (): Error => new Error("模型修改了受保护的链接引用或返回了未知链接；审阅结果未接受，原稿已保留。");
  const referencePattern = new RegExp(`${prefix}\\d+__`, "g");
  const restore = (text: string): string => {
    text = text.replace(referencePattern, (reference: string): string => {
      const url = links.get(reference);
      if (url === undefined) throw invalid();
      return url;
    });
    if (text.includes(prefix)) throw invalid();
    return text;
  };
  const validate = (markdown: string): void => {
    if (destinations(markdown).some(span => !references.has(span.value))) throw invalid();
  };
  return {
    input,
    restoreResponse(response: string): string {
      const candidate = response.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
      let parsed: unknown;
      try { parsed = JSON.parse(candidate, (_key: string, value: unknown): unknown => typeof value === "string" ? restore(value) : value); }
      catch (error) { if (error instanceof SyntaxError) return response; throw error; }
      if (parsed && typeof parsed === "object" && "markdown" in parsed && typeof parsed.markdown === "string") validate(parsed.markdown);
      return JSON.stringify(parsed);
    },
    preview(response: string): string | undefined {
      // 半个编号暂缓展示，完整编号按 JSON 字符串转义还原，避免流式预览出现损坏地址。
      let restored = response.replace(referencePattern, (reference: string): string => {
        const url = links.get(reference);
        return url === undefined ? reference : JSON.stringify(url).slice(1, -1);
      });
      const pending = restored.indexOf(prefix);
      if (pending >= 0) restored = restored.slice(0, pending);
      for (let length = Math.min(prefix.length - 1, restored.length); length > 0; length--) {
        if (restored.endsWith(prefix.slice(0, length))) { restored = restored.slice(0, -length); break; }
      }
      try { validate(partialReviewContent(restored).markdown); }
      catch { return undefined; }
      return restored;
    },
  };
}

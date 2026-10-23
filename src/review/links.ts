/** 审阅时仅向模型提供链接引用，真实地址由本次请求的本地映射持有。 */
import { partialReviewContent } from "./stream";

interface Wrapper { start: number; end: number; kind: "image" | "link" | "attribute" | "definition"; label?: string }
interface Destination { start: number; end: number; value: string; wrapper?: Wrapper }
interface StringIssue extends Destination { id: string; path: string }
export interface LinkRepairRequest {
  issues: Array<{ id: string; context: string }>;
  candidates: Array<{ reference: string; context: string }>;
  feedback: string;
}
export interface LockedReviewLinks {
  input: string;
  restoreResponse(response: string): string;
  preview(response: string): string | undefined;
  repairRequest(response: string, attempt: number, feedback: string): LinkRepairRequest | null;
  applyRepairs(response: string, patches: unknown, request: LinkRepairRequest): string;
  fallbackResponse(response: string): { response: string; unresolved: number };
}

/** 找出行内链接的显示文字边界，供失败降级时去掉目标并保留文字。 */
function labelStart(text: string, close: number): number {
  let depth = 0;
  for (let index = close - 1; index >= 0; index--) {
    if (text[index - 1] === "\\") { index--; continue; }
    if (text[index] === "]") depth++;
    if (text[index] === "[") { if (!depth) return index; depth--; }
  }
  return -1;
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
    if (!found) continue;
    if (match[0].startsWith("](")) {
      const start = labelStart(text, match.index);
      const tail = found.end + (text[found.end] === ">" ? 1 : 0);
      const close = /^[ \t]*(?:(?:"[^"\n]*"|'[^'\n]*')[ \t]*)?\)/.exec(text.slice(tail));
      if (start >= 0 && close) found.wrapper = { start: start - (text[start - 1] === "!" ? 1 : 0), end: tail + close[0].length,
        kind: text[start - 1] === "!" ? "image" : "link", label: text.slice(start + 1, match.index) };
    } else found.wrapper = { start: match.index, end: text.indexOf("\n", found.end) < 0 ? text.length : text.indexOf("\n", found.end), kind: "definition" };
    spans.push(found);
  }
  for (const match of text.matchAll(/\b(?:href|src)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi)) {
    const value = match[2] ?? match[3];
    const start = match.index + (match[1] ? match[0].indexOf(match[1]) + 1 : match[0].length - value.length);
    spans.push({ start, end: start + value.length, value, wrapper: { start: match.index, end: match.index + match[0].length, kind: "attribute" } });
  }
  for (const match of text.matchAll(/<(?:https?:\/\/|mailto:|ftp:\/\/)[^>\n]+>/gi)) {
    spans.push({ start: match.index + 1, end: match.index + match[0].length - 1, value: match[0].slice(1, -1),
      wrapper: { start: match.index, end: match.index + match[0].length, kind: "link" } });
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

/** 只访问 JSON 字符串值；修复补丁无权改写结构、字段或整篇正文。 */
function mapStrings(value: unknown, transform: (text: string, path: string) => string, path = ""): unknown {
  if (typeof value === "string") return transform(value, path);
  if (Array.isArray(value)) return value.map((item, index) => mapStrings(item, transform, `${path}/${index}`));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, mapStrings(item, transform, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`)]));
  return value;
}

function parseResponse(response: string): unknown {
  return JSON.parse(response.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "")) as unknown;
}

/** 修改范围按原始坐标应用；嵌套的外层降级覆盖内层，避免偏移损坏正文。 */
function editSpans(text: string, edits: Array<{ start: number; end: number; replacement: string }>): string {
  let result = "", position = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (edit.start < position) continue;
    result += text.slice(position, edit.start) + edit.replacement; position = edit.end;
  }
  return result + text.slice(position);
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
  /** 定位错误仅用于反馈与应用 AI 补丁，不推测任何编号或原图对应关系。 */
  const stringIssues = (text: string, path: string): Destination[] => {
    const issues = path === "/markdown" ? destinations(text).filter(span => !links.has(span.value) && !references.has(span.value)) : [];
    let position = 0;
    while ((position = text.indexOf(prefix, position)) >= 0) {
      const closing = text.indexOf("__", position + prefix.length);
      const boundary = text.slice(position).search(/[\s<>)\]]/);
      const limit = boundary < 0 ? text.length : position + boundary;
      const end = closing >= 0 && closing + 2 <= limit ? closing + 2 : Math.min(limit, position + 128);
      const value = text.slice(position, end);
      if (!links.has(value) && !issues.some(issue => position >= issue.start && position < issue.end)) issues.push({ start: position, end, value });
      position = Math.max(position + prefix.length, end);
    }
    return issues.sort((a, b) => a.start - b.start);
  };
  const analyze = (response: string): { parsed: unknown; issues: StringIssue[]; fields: Map<string, string> } => {
    const parsed = parseResponse(response), issues: StringIssue[] = [], fields = new Map<string, string>();
    mapStrings(parsed, (text: string, path: string): string => {
      fields.set(path, text);
      for (const span of stringIssues(text, path)) issues.push({ ...span, id: `issue${issues.length + 1}`, path });
      return text;
    });
    return { parsed, issues, fields };
  };
  const fallbackText = (text: string, path: string): string => editSpans(text, stringIssues(text, path).map(issue => {
    const wrapper = issue.wrapper;
    const label = wrapper?.label ? fallbackText(wrapper.label, "/markdown") : "";
    const replacement = wrapper?.kind === "image" ? `${label}【图片引用待确认】`
      : wrapper?.kind === "attribute" || wrapper?.kind === "definition" ? "" : `${label}【链接待确认】`;
    return { start: wrapper?.start ?? issue.start, end: wrapper?.end ?? issue.end, replacement };
  }));
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
    repairRequest(response: string, attempt: number, feedback: string): LinkRepairRequest | null {
      let analysis: ReturnType<typeof analyze>;
      try { analysis = analyze(response); } catch { return null; }
      if (!analysis.issues.length) return null;
      const issues = analysis.issues.slice(0, 8).map(issue => {
        const field = analysis.fields.get(issue.path)!;
        const marker = `【待修复 ${issue.id}】`;
        const targets = destinations(field);
        const covering = targets.find(span => issue.start >= span.start && issue.end <= span.end);
        const edits = targets.map(span => ({ ...span, replacement: references.get(span.value) || (links.has(span.value) ? span.value : "【未知链接】") }));
        // 错误标记优先于地址脱敏；真实 URL 不进入修复请求。
        const safe = editSpans(field, [{ start: covering?.start ?? issue.start, end: covering?.end ?? issue.end, replacement: marker }, ...edits]);
        const at = safe.indexOf(marker);
        return { id: issue.id, context: safe.slice(Math.max(0, at - 48), at + marker.length + 48) };
      });
      const ids = [...links.keys()], offset = ids.length ? ((attempt - 1) * 32) % ids.length : 0;
      const candidates = [...ids.slice(offset), ...ids.slice(0, offset)].slice(0, 32).map(reference => {
        const at = input.indexOf(reference);
        return { reference, context: input.slice(Math.max(0, at - 36), at + reference.length + 36) };
      });
      const request = { issues, candidates, feedback: feedback.slice(0, 200) };
      while (JSON.stringify(request).length > 6000 && candidates.length > 1) candidates.pop();
      return request;
    },
    applyRepairs(response: string, patches: unknown, request: LinkRepairRequest): string {
      if (!Array.isArray(patches) || patches.length > request.issues.length) throw invalid();
      const analysis = analyze(response), changes = new Map<string, string>(), allowed = new Set(request.issues.map(issue => issue.id)), seen = new Set<string>();
      const candidates = new Set(request.candidates.map(candidate => candidate.reference));
      for (const patch of patches) {
        if (!patch || typeof patch !== "object" || typeof patch.issue !== "string" || !allowed.has(patch.issue) || seen.has(patch.issue)) throw invalid();
        seen.add(patch.issue);
        if (patch.reference === null) continue;
        if (typeof patch.reference !== "string" || !links.has(patch.reference) || !candidates.has(patch.reference)) throw invalid();
        changes.set(patch.issue, patch.reference);
      }
      if (!changes.size) throw invalid();
      return JSON.stringify(mapStrings(analysis.parsed, (text, path) => editSpans(text, analysis.issues.filter(issue => issue.path === path && changes.has(issue.id))
        .map(issue => ({ start: issue.start, end: issue.end, replacement: changes.get(issue.id)! })))));
    },
    fallbackResponse(response: string): { response: string; unresolved: number } {
      const analysis = analyze(response);
      const safe = JSON.stringify(mapStrings(analysis.parsed, fallbackText));
      return { response: this.restoreResponse(safe), unresolved: analysis.issues.length };
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

/** 与 Noosphere 相同的输出语言选项；界面跟随模式在每次请求时解析。 */
export type OutputLanguage = "follow_ui" | "source" | "zh-CN" | "en-US";
export const OUTPUT_LANGUAGE_OPTIONS = [["follow_ui", "跟随思源界面"], ["source", "保持原文语言"], ["zh-CN", "简体中文"], ["en-US", "英文"]] as const;

export function normalizeOutputLanguage(value: unknown): OutputLanguage {
  return OUTPUT_LANGUAGE_OPTIONS.some(([id]) => id === value) ? value as OutputLanguage : "follow_ui";
}

export function resolveOutputLanguage(value: unknown, interfaceLanguage?: string): Exclude<OutputLanguage, "follow_ui"> {
  const selected = normalizeOutputLanguage(value);
  if (selected !== "follow_ui") return selected;
  const ui = interfaceLanguage ?? (typeof window === "undefined" ? undefined : (window as unknown as { siyuan?: { config?: { lang?: string } } }).siyuan?.config?.lang);
  return /^en(?:[-_]|$)/i.test(ui || "") ? "en-US" : "zh-CN";
}

/** 语言规则同时覆盖模板章节与 AI 补充，代码、链接和来源证据保留原样。 */
export function outputLanguagePrompt(value: unknown): string {
  const language = resolveOutputLanguage(value);
  const instruction = language === "source" ? "保持抓取原文的主要语言，不把整篇文章翻译成其他语言。模板中的示例章节名称也使用原文语言。"
    : language === "en-US" ? "文章标题、Markdown 正文、章节名称、摘要、讲解、AI 补充和内部 summary 全部使用英文（English）。"
    : "文章标题、Markdown 正文、章节名称、摘要、讲解、AI 补充和内部 summary 全部使用简体中文。";
  return `${instruction}\n语言选择优先于视角和文章格式中的示例语言。代码、URL、专有名词、必要的原文引文和元数据证据保留原样；JSON 字段名保持接口要求，不要翻译。`;
}

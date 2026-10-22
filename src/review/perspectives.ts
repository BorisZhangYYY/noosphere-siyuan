/** Review viewpoints and free-form article-format instructions. */
import { composeArticle } from "../article/compose";
import { outputLanguagePrompt } from "./language";
import { nestReviewBodyHeadings } from "./headings";
import type { Article, ReviewPerspective, Settings } from "../types";

const COMMON_PROMPT = `你正在把抓取到的文章整理为个人知识库中的可信审阅稿。

## 信息边界
- 保留事实、数据、阈值、引文、代码、表格、推理链、失败经验和关键类比；不得编造来源或强化原文结论。
- 保留有效图片和链接及其叙事位置；图片地址必须逐字复制输入中的地址，不得增删字符、改写路径或添加输入中不存在的图片。
- 删除广告、推广、关注订阅提示、平台交互噪音和跟踪文本；有事实与限定条件的旁白必须保留。

## 输出
- 按文章格式要求自由安排正文的标题和段落；不要用固定内容槽位。
- 不要自行输出来源、作者或发布时间；知流负责组装这些元数据。
- AI 补充的内容使用引用块并注明是 AI 补充。
- 严格遵循末尾的 JSON 接口格式。`;

export const REVIEW_PERSPECTIVES: Record<"original" | "novice", ReviewPerspective> = {
  original: {
    id: "original", label: "基于原文", description: "保留作者的论证结构，只清理噪音并优化表达。",
    prompt: `以原作者的视角审阅，目标是得到一份经过清理与校对、但仍忠实于原作的版本。
保持作者的立场、论证顺序、解释节奏、章节结构和不确定性程度；优先做精确编辑，不做摘要式重写。
完整保留“为什么常见方案失败”“为什么选择某个阈值或方案”等因果链，以及生产环境中的真实经验。
除非缺少定义会直接阻碍理解，否则不要补充背景；确需补充时使用注明模型的引用块。
不要新建原文不存在的附录或图片收纳章节。`,
    template: `按以下 Markdown 版式组织正文。括号内是写作要求，不要原样输出。

---

## AI 摘要

（用 3–5 条要点概括原文讨论的问题、核心结论和适用边界；每条给出实质信息，不写空泛套话。）

---

## 正文

（沿用原文的章节与论证顺序，完整整理事实、推理、代码、表格、引文、链接和相关图片。原文章节属于“正文”的子章节，从 ### 开始，内部小标题继续向下嵌套，保留相对层级。不要把原文章节与 ## 正文并列，不把完整正文压缩为摘要。）
`,
  },
  novice: {
    id: "novice", label: "小白视角", description: "补充必要背景与术语解释，降低首次阅读门槛。",
    prompt: `以第一次接触主题的读者视角审阅，在不损失原文精度的前提下降低理解门槛。
保持原文论证与信息完整，补充真正必要的前置知识、缩写、术语、隐含跳步和结论边界。
讲解应紧邻所解释的段落，并使用注明模型的引用块；避免居高临下、滥用类比或用泛化总结替换技术细节。
正文保持原文顺序与全部有效信息。`,
    template: `按以下 Markdown 版式组织正文。括号内是写作要求，不要原样输出。

---

## 快速理解

（用 3–5 条要点说明原文要解决的问题、核心结论和适用边界，让第一次接触主题的读者先建立整体认识。）

---

## 阅读前准备

（只解释读懂正文真正需要的背景、缩写和术语；没有必要内容时写“无需额外背景”。）

---

## 正文与讲解

（保留原文顺序、章节、事实、引用、链接和图片。原文章节属于“正文与讲解”的子章节，从 ### 开始，内部小标题继续向下嵌套，保留相对层级。在相应段落旁解释隐含跳步与必要概念；AI 补充用注明模型的引用块标识。）
`,
  },
};

export const OUTLINE_FORMAT = `不要单独生成 AI 摘要。按以下 Markdown 版式组织正文。括号内是写作要求，不要原样输出；要点数量由原文决定。

---

## 要点 1

（先写核心结论，再写原文依据、必要的原文片段与引用，以及结论的适用边界。）

## 要点 2

（用同样方式展开下一要点。依文章内容增减要点，保留相关链接和图片。）

---

## 总结

（概括要点之间的关系，不加入原文没有的事实。）`;

/** Convert saved slot templates into readable guidance once, without losing section intent. */
export function migratePerspective(perspective: ReviewPerspective): ReviewPerspective {
  if (!perspective.template.includes("{{")) return { ...perspective, sections: undefined };
  const sections = perspective.sections || [];
  let format = perspective.template
    .replace(/^\s*#\s*\{\{\s*title\s*\}\}\s*$/gim, "")
    .replace(/^\s*\{\{\s*source_metadata\s*\}\}\s*$/gim, "")
    .replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (_, id: string) => {
      const section = sections.find(item => item.id === id);
      return section ? `（内容要求：${section.instruction}）` : `（根据视角要求写出 ${id} 内容）`;
    });
  format = format.replace(/\n{3,}/g, "\n\n").trim();
  return { ...perspective, template: `请参考下列结构生成文章正文；标题和来源由知流处理。\n\n${format}`, sections: undefined };
}

/** User guidance is free text; only empty or excessively long settings are rejected. */
export function validatePerspective(perspective: ReviewPerspective): void {
  if (!perspective.label.trim()) throw new Error("请填写视角名称");
  if (!perspective.prompt.trim()) throw new Error("请填写视角提示词");
  if (!perspective.template.trim() || perspective.template.length > 20000) throw new Error("请填写有效的文章格式要求");
}

export function getPerspective(settings: Settings): ReviewPerspective {
  const id = settings.reviewPerspective;
  const perspective = REVIEW_PERSPECTIVES[id as keyof typeof REVIEW_PERSPECTIVES]
    || settings.customPerspectives?.find(item => item.id === id);
  if (!perspective) throw new Error("审阅视角不存在，请重新选择");
  validatePerspective(perspective);
  return perspective;
}

export function buildReviewPrompt(settings: Settings): string {
  const perspective = getPerspective(settings);
  return `# 固定通用约束\n\n${COMMON_PROMPT}\n\n# 审阅视角：${perspective.label}\n\n${perspective.prompt}\n\n# 文章格式要求\n\n${perspective.template}\n\n# 输出语言\n\n${outputLanguagePrompt(settings.outputLanguage)}\n\n# JSON 接口格式\n\n只返回一个 JSON 对象，不加代码围栏或额外说明。正文可以自由使用 Markdown，不需要变量或固定区块。summary 是供后续图片审阅使用的内部摘要：即使文章格式要求“不显示摘要”，也要填写 summary，但不要因此在 markdown 中添加摘要段落。\nmetadata_candidates 仅在抓取到的作者或发布时间缺失、且原文有明确证据时填写。evidence 必须逐字摘自抓取原文，不得猜测。published_at 使用 YYYY-MM-DD；没有明确的年月日就保持 null。已抓取到的字段保持 null。\n{\n  "title": "审阅后的文章标题",\n  "markdown": "正文 Markdown；不要在这里重复标题或来源元数据",\n  "summary": "概括文章主题、结论和图片判断所需的上下文；不会写进文章",\n  "metadata_candidates": {\n    "author": null,\n    "published_at": null\n  }\n}\n有证据时，把对应的 null 改成 {"value":"字段值","evidence":"原文中的原样片段"}。`;
}

export interface ReviewResult { markdown: string; article: Article; summary: string; metadataAccepted: string[] }

function sourceSupports(value: string, evidence: string, isDate: boolean): boolean {
  const folded = evidence.toLocaleLowerCase();
  if (!isDate) return folded.includes(value.toLocaleLowerCase());
  const parts = value.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!parts) return false;
  const [, year, month, day] = parts;
  const valid = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (valid.getUTCFullYear() !== Number(year) || valid.getUTCMonth() !== Number(month) - 1 || valid.getUTCDate() !== Number(day)) return false;
  if (folded.includes(value.toLocaleLowerCase())) return true;
  const numbers = [...folded.matchAll(/\d+/g)].map(match => String(Number(match[0])));
  return [year, month, day].every(part => numbers.includes(String(Number(part))));
}

/** Accept only evidence-backed metadata for fields the crawler left empty. */
export function parseReviewResult(response: string, article: Article, settings: Settings): ReviewResult {
  const perspective = getPerspective(settings);
  const candidate = response.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  let parsed: { title?: unknown; markdown?: unknown; summary?: unknown; metadata_candidates?: Record<string, unknown> };
  try { parsed = JSON.parse(candidate) as typeof parsed; }
  catch { throw new Error("AI 没有返回有效的审阅 JSON，请重试或调整模型输出长度"); }
  if (!parsed || typeof parsed.title !== "string" || !parsed.title.trim() || typeof parsed.markdown !== "string" || !parsed.markdown.trim()) throw new Error("AI 审阅结果缺少标题或正文");
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) throw new Error("AI 审阅结果缺少供图片判断使用的摘要，请重试");
  const source = article.markdown.replace(/\s+/g, " ").toLocaleLowerCase();
  const enriched: Article = { ...article };
  const metadataAccepted: string[] = [];
  for (const [key, output] of [["author", "author"], ["published_at", "publishedAt"]] as const) {
    if (enriched[output]) continue;
    const item = parsed.metadata_candidates?.[key] as { value?: unknown; evidence?: unknown } | undefined;
    if (!item || typeof item.value !== "string" || typeof item.evidence !== "string") continue;
    const value = item.value.trim().replace(/\s+/g, " ");
    const evidence = item.evidence.trim().replace(/\s+/g, " ");
    if (!value || value.length > 160 || evidence.length < 4 || !source.includes(evidence.toLocaleLowerCase()) || !sourceSupports(value, evidence, output === "publishedAt")) continue;
    enriched[output] = value;
    metadataAccepted.push(output);
  }
  const title = parsed.title.trim().replace(/\s+/g, " ");
  let markdown = parsed.markdown.trim().replace(/^#\s+[^\n]*\n+/, "");
  markdown = markdown.replace(/^(?:>\s*(?:来源|Source|作者|Author|发布时间|Published)\s*[:：][^\n]*(?:\n|$)\s*)+/i, "").trim();
  if (!markdown) throw new Error("AI 审阅结果缺少正文");
  markdown = nestReviewBodyHeadings(markdown, perspective.id);
  return { markdown: composeArticle(enriched, `# ${title}\n\n${markdown}`), article: enriched, summary: parsed.summary.trim().slice(0, 1600), metadataAccepted };
}

export function renderReview(response: string, article: Article, settings: Settings): string {
  return parseReviewResult(response, article, settings).markdown;
}

/**
 * 分类：把审阅稿交给模型，在用户已有的分类文档里选一个落点。
 * 与 Noosphere 本体一致，模型只能选择、不能创建；置信度不足或候选为空时落到根文档。
 */
import { requestShortText } from "./short-request";
import { classificationCandidates, type CategoryNode } from "../siyuan/tree";
import type { Settings } from "../types";

/** 低于该置信度视为没有把握，交给调用方回落到根文档。 */
export const CLASSIFY_CONFIDENCE = 0.6;

export const CLASSIFY_PROMPT = `你把一篇已审阅的文章放入用户已有的分类文档中。

你只能从给定的分类列表里选择一个 ID，绝不能创建、重命名、翻译或建议任何分类。
优先选择完整路径明确匹配文章主题的最深分类。分类文档可以同时容纳子分类和文章。

如果没有明确匹配的已有分类，返回 null 的 collection_id，应用会把文章放在分类根下。
confidence 是 0 到 1 的数字，应综合完整分类路径、分类介绍与文章主题判断。

只返回如下 JSON，不要包含代码围栏：

{"collection_id": "已有分类 ID 或 null", "confidence": 0.84, "reason": "文章主题与该分类路径匹配的原因"}`;

export interface ClassificationResult {
  /** 命中的分类文档 ID；未命中时为 null,调用方应落到根文档。 */
  categoryId: string | null;
  confidence: number;
  reason: string;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("分类结果不是有效的 JSON 对象");
  const payload = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("分类结果必须是 JSON 对象");
  return payload as Record<string, unknown>;
}

export interface ClassifyOptions {
  signal?: AbortSignal;
}

/**
 * 让模型在已有分类中选一个落点。
 * 分类为空时不调用模型，直接把文章放在根文档，避免无意义的请求与费用。
 */
export async function classifyArticle(
  title: string,
  markdown: string,
  categories: CategoryNode[],
  settings: Settings,
  options: ClassifyOptions = {},
): Promise<ClassificationResult> {
  if (!categories.length) return { categoryId: null, confidence: 0, reason: "没有已配置的分类" };
  if (!settings.modelKey.trim() || !settings.modelName.trim()) throw new Error("请配置模型 API Key 和模型名称");
  // 分类只需要主题信息；截断长文既省 token 也避免分类被正文细节带偏。
  const excerpt = markdown.slice(0, 4000);
  const userMessage = `已有分类：\n${JSON.stringify(classificationCandidates(categories), null, 1)}\n\n文章标题：${title}\n\n文章正文节选：\n${excerpt}`;
  const text = await requestShortText(settings, CLASSIFY_PROMPT, userMessage, options.signal);
  if (!text.trim()) throw new Error("模型没有返回分类结果");
  const parsed = extractJsonObject(text);
  const rawId = typeof parsed.collection_id === "string" ? parsed.collection_id.trim() : "";
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  const rawConfidence = Number(parsed.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
  if (!rawId) return { categoryId: null, confidence, reason: reason || "没有明确匹配的已有分类" };
  // 模型可能编造 ID，只有真实存在的分类才允许落库。
  const matched = categories.find(category => category.id === rawId);
  if (!matched) return { categoryId: null, confidence, reason: `模型返回了不存在的分类：${rawId}` };
  if (confidence < CLASSIFY_CONFIDENCE) return { categoryId: null, confidence, reason: reason || "分类置信度不足" };
  return { categoryId: matched.id, confidence, reason };
}

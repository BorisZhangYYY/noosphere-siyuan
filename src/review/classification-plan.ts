/** 分类规则随用户文档变化：模型返回后和正式写入前均重新读取并核验。 */
import { locateDocument, type DocumentLocation } from "../siyuan/location";
import { discoverCategories, type CategoryNode } from "../siyuan/tree";
import { classifyArticle, type ClassificationResult } from "./classify";
import type { Article, Settings } from "../types";

export interface ClassificationPlan { root: DocumentLocation; decision: ClassificationResult; where: string; signature: string }
function signature(root: DocumentLocation, categories: CategoryNode[]): string {
  return JSON.stringify([root.id, root.notebook, root.path, categories.map(item => [item.id, item.path, item.description])]);
}
async function snapshot(rootId: string): Promise<{ root: DocumentLocation; categories: CategoryNode[]; signature: string }> {
  const root = await locateDocument(rootId);
  const categories = await discoverCategories(root);
  return { root, categories, signature: signature(root, categories) };
}

/** 规则在请求期间改变时重算一次；持续变动时保留草稿，避免写入过期落点。 */
export async function prepareClassification(rootId: string, article: Article, markdown: string, settings: Settings): Promise<ClassificationPlan> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await snapshot(rootId);
    let decision: ClassificationResult;
    try { decision = await classifyArticle(article.title, markdown, before.categories, settings); }
    catch (error) { decision = { categoryId: null, confidence: 0, reason: `分类失败：${error instanceof Error ? error.message : String(error)}` }; }
    const after = await snapshot(rootId);
    if (after.signature !== before.signature) continue;
    return { root: after.root, decision, signature: after.signature,
      where: after.categories.find(item => item.id === decision.categoryId)?.path || "分类根" };
  }
  throw new Error("分类规则或根文档在审阅期间发生变化，请确认后重试；文章仍保留在草稿中");
}

/** 图片本地化等异步步骤完成后再次核验，避免期间删除、移动或修改分类。 */
export async function validateClassification(plan: ClassificationPlan, article: Article, markdown: string, settings: Settings): Promise<ClassificationPlan> {
  const current = await snapshot(plan.root.id);
  return current.signature === plan.signature ? { ...plan, root: current.root } : prepareClassification(plan.root.id, article, markdown, settings);
}

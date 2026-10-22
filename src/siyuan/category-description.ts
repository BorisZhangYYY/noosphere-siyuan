/** 分类描述有独立区域；标记用于在用户修改标题后继续定位原区域。 */
export const DESCRIPTION_ATTR = "custom-zl-description";
export const DESCRIPTION_HEADING_ATTR = "custom-zl-description-heading";
export interface DescriptionSection { headingId?: string; level: number; content: string }

/** 跳过围栏中的伪标题，按同级或更高级标题界定描述区域。 */
export function descriptionSection(markdown: string): DescriptionSection | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headings: Array<{ line: number; body: number; level: number; title: string; attrs: string }> = [];
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const fenced = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (fenced) { if (!fence) fence = fenced[1][0]; else if (fence === fenced[1][0]) fence = ""; continue; }
    if (fence) continue;
    const heading = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    let body = i + 1, attrs = "";
    while (body < lines.length && /^\s*\{:[^\n]*\}\s*$/.test(lines[body])) attrs += " " + lines[body++];
    headings.push({ line: i, body, level: heading[1].length, title: heading[2], attrs });
  }
  const boundId = markdown.match(new RegExp(`${DESCRIPTION_HEADING_ATTR}="(\\d{14}-[a-z0-9]{7})"`))?.[1];
  const heading = headings.find(item => boundId && item.attrs.includes(`id="${boundId}"`))
    || headings.find(item => item.attrs.includes(`${DESCRIPTION_ATTR}="true"`))
    || headings.find(item => item.title === "分类描述");
  if (!heading) return null;
  const end = headings.find(item => item.line > heading.line && item.level <= heading.level)?.line ?? lines.length;
  return { headingId: heading.attrs.match(/(?:^|\s)id="(\d{14}-[a-z0-9]{7})"/)?.[1], level: heading.level,
    content: cleanDescription(lines.slice(heading.body, end).join("\n")) };
}

/** 属性和自动引用不参与模型的分类规则，避免目录文字混入介绍。 */
function cleanDescription(text: string): string {
  return text.replace(/^\s*\{:[^\n]*\}\s*$/gm, "").replace(/\(\(\d{14}-[a-z0-9]{7}[\s\S]*?\)\)/g, "")
    .replace(/^\s*[*+-]\s*$/gm, "").trim().slice(0, 2000);
}

/** 新区域优先于旧属性；旧文档在管理页迁移之前仍可正常分类。 */
export function readCategoryDescription(markdown: string, legacyAttribute = ""): string {
  const section = descriptionSection(markdown);
  if (section) return section.content;
  if (legacyAttribute.trim()) return legacyAttribute.trim().slice(0, 2000);
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/^\s*\{:[^\n]*\}\s*$/gm, "");
  const first = body.split(/\n\s*\n/).map(block => block.trim()).find(block => block
    && !/^(---|\*\*\*|___)$/.test(block) && !/^#{1,6}\s+/.test(block)
    && !/^(?:[*+-]|\d+\.)\s|^```|^~~~|^\{\{/.test(block));
  return first ? first.replace(/^>\s*/gm, "").replace(/\s+/g, " ").slice(0, 2000) : "";
}

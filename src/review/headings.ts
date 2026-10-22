/** 内置审阅版式的正文是父章节，原文章节在其中保留相对层级。 */
interface Heading { index: number; level: number; title: string }

/** 只读取实际标题，代码块和引用中的 Markdown 示例不参与层级计算。 */
function headings(lines: string[]): Heading[] {
  let fence: string | undefined;
  const result: Heading[] = [];
  lines.forEach((line: string, index: number): void => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return;
    }
    const heading = !fence && /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) result.push({ index, level: heading[1].length, title: heading[2].replace(/\*|_/g, "").trim() });
  });
  return result;
}

/** 仅修正内置格式最后的正文容器；自定义版式继续由用户的格式要求决定。 */
export function nestReviewBodyHeadings(markdown: string, perspectiveId: string): string {
  const title = perspectiveId === "original" ? /^(?:正文|body|main body|main text|article body)$/i
    : perspectiveId === "novice" ? /^(?:正文与讲解|body (?:and|with) explanations?|main text (?:and|with) explanations?)$/i : undefined;
  if (!title) return markdown;
  const lines = markdown.split("\n");
  const found = headings(lines);
  const parent = found.find(heading => heading.level === 2 && title.test(heading.title));
  if (!parent) return markdown;
  const children = found.filter(heading => heading.index > parent.index);
  if (!children.length) return markdown;
  const shift = Math.max(0, parent.level + 1 - Math.min(...children.map(heading => heading.level)));
  if (!shift) return markdown;
  for (const heading of children) {
    lines[heading.index] = lines[heading.index].replace(/^( {0,3})#{1,6}/, `$1${"#".repeat(Math.min(6, heading.level + shift))}`);
  }
  return lines.join("\n");
}

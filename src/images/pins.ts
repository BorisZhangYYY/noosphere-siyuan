/** 正文未引用的素材仍需随知流历史保留；用思源自定义资源属性把它们计入引用，避免被未引用资源清理删除。 */
import { kernelPost } from "../siyuan/api";
import { localAssetPath } from "./reference";

/** 思源只扫描文档、模板和数据库中的资源，插件存储不被统计，因此必须写入原子性可解引用的绑定。 */
const PIN_PREFIX = "custom-data-assets-zl";
const LOCAL_ASSET = /(?<![\w./-])\/?assets\/[^\s"'()<>\\,]+/g;

/** 历史条目 ID 转成合法属性名片段；只用小写字母数字，避免思源拒绝非法属性名。 */
export function pinEntryKey(entryId: string): string {
  return entryId.replace(/[^a-z0-9]/gi, "").toLowerCase() || "draft";
}

/** 从正文、原生块 DOM 或素材记录中取出本地资源地址，远程地址与站点自带的 assets 路径不算。 */
export function localAssetReferences(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(LOCAL_ASSET)) {
    const path = localAssetPath(match[0]);
    if (path) paths.add(path.replace(/^\//, ""));
  }
  return [...paths];
}

/** 文档 kramdown 的属性行包含绑定本身；判定“正文是否已引用”前必须剔除，否则绑定会变成自我引用。 */
export function stripPinAttributes(text: string): string {
  return text.replace(/\{:[^}\n]*\}/g, ial => ial.replace(/\s+custom-data-assets-zl-[\w-]+\s*=\s*(?:"[^"]*"|'[^']*')/g, ""));
}

/** 已写入文档的图片由文档自身引用；其余素材（已移除、待定位、未保存草稿）需要额外绑定。 */
export function unreferencedAssets(body: string, candidates: readonly string[]): string[] {
  const referenced = new Set(localAssetReferences(body));
  const pinned = new Set<string>();
  for (const candidate of candidates) {
    const path = localAssetPath(candidate)?.replace(/^\//, "");
    if (!path || referenced.has(path) || pinned.has(path)) continue;
    pinned.add(path);
  }
  return [...pinned];
}

interface PinOptions {
  /** 单图单属性：思源普通资源清理只把整条属性值当作一个资源地址，多值不会被拆分。 */
  prefix?: string;
  /** 恢复期间条目可能被同步删除；内核读取后、提交前必须复核。 */
  shouldWrite?: () => boolean;
}

function pinAttributes(entryId: string, paths: readonly string[]): Record<string, string> {
  const key = pinEntryKey(entryId);
  const attrs: Record<string, string> = {};
  [...new Set(paths)].sort().forEach((path, index) => {
    attrs[`${PIN_PREFIX}-${key}-${index + 1}`] = path;
  });
  return attrs;
}

/** 让目标文档的素材绑定与本次历史条目一致：写入缺失项，清空过期项，内容未变化时不发请求。 */
export async function syncAssetPins(documentId: string, entryId: string, paths: readonly string[],
  options: PinOptions = {}): Promise<{ pinned: number; changed: boolean }> {
  const desired = pinAttributes(entryId, paths);
  const total = Object.keys(desired).length;
  // 尚未写入文档时无处绑定；已保存时即使素材为空也要清空旧绑定。
  if (!documentId) return { pinned: 0, changed: false };
  const prefix = options.prefix || `${PIN_PREFIX}-${pinEntryKey(entryId)}-`;
  const current = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id: documentId });
  const updates: Record<string, string> = {};
  for (const [name, value] of Object.entries(desired)) if (current?.[name] !== value) updates[name] = value;
  for (const name of Object.keys(current || {})) if (name.startsWith(prefix) && !(name in desired)) updates[name] = "";
  // 旧十位前缀无法可靠归属（fallback ID 可碰撞）；保留遗留保护，不冒险释放其他历史资源。
  if (options.shouldWrite && !options.shouldWrite()) return { pinned: 0, changed: false };
  if (!Object.keys(updates).length) return { pinned: total, changed: false };
  await kernelPost("/api/attr/setBlockAttrs", { id: documentId, attrs: updates });
  return { pinned: total, changed: true };
}

/** 删除历史条目后释放素材绑定：文档不存在或从未保存时静默结束。 */
export async function clearAssetPins(documentId: string, entryId: string, options: PinOptions = {}): Promise<number> {
  if (!documentId) return 0;
  const prefix = options.prefix || `${PIN_PREFIX}-${pinEntryKey(entryId)}-`;
  const current = await kernelPost<Record<string, string>>("/api/attr/getBlockAttrs", { id: documentId }).catch(() => null);
  if (!current) return 0;
  const stale = Object.keys(current).filter(name => name.startsWith(prefix));
  if (!stale.length) return 0;
  await kernelPost("/api/attr/setBlockAttrs", { id: documentId, attrs: Object.fromEntries(stale.map(name => [name, ""])) });
  return stale.length;
}

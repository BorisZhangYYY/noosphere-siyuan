/** 仅登记确有特殊规则的平台；没有命中的站点自动使用通用策略。 */
import type { PlatformPolicy } from "./types";
import { wechat } from "./wechat";
import { xiaoheihe } from "./xiaoheihe";
import { zhihu } from "./zhihu";

const platforms: readonly PlatformPolicy[] = [wechat, xiaoheihe, zhihu];

/** 统一查询平台规则，避免请求层和来源展示层分别维护域名判断。 */
export function resolvePlatform(url: URL): PlatformPolicy | undefined {
  return platforms.find(platform => platform.matches(url));
}

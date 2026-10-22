/** Firecrawl 已返回、尚未进入文章历史的内容；平台只接触当前插件可用的数据。 */
export interface CaptureResult {
  markdown: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  statusCode?: number;
}

/** 平台例外的最小约定：链接规整、结果整理与有效性检查，不复制抓取流程。 */
export interface PlatformPolicy {
  readonly sourceName: string;
  matches(url: URL): boolean;
  canonicalArticleUrl?(url: URL): URL;
  validateCapture?(capture: CaptureResult): void;
  processCapture?(capture: CaptureResult, originalUrl: URL): CaptureResult;
}

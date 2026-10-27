/** 默认等待上限集中管理：长文允许持续输出，停滞与短请求及时退出。 */
export const KERNEL_TIMEOUT_MS = 30000;
export const MODEL_SHORT_TIMEOUT_MS = 30000;
/** 文字审阅静默提醒的间隔，不要求模型已经输出正文。 */
export const REVIEW_IDLE_TIMEOUT_MS = 90000;
/** 流式以最后一次思考/正文进展续期；非流式无法观察进展，仍以整次请求计时。 */
export const REVIEW_PROGRESS_TIMEOUT_MS = 600000;
export const IMAGE_REVIEW_TIMEOUT_MS = 60000;
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;
export const IMAGE_LOCALIZATION_TIMEOUT_MS = 120000;

/** 审阅阶段随草稿与历史持久化；运行中的任务重开后可从阶段边界恢复。 */
export interface ReviewCheckpoint {
  stage: "text" | "images" | "complete";
  status: "running" | "paused" | "complete";
  imageReview: boolean;
  linkRepair?: { attempts: number; unresolved: number };
  saveFailed?: boolean;
}

/** 不依赖旧草稿必有新字段，损坏的断点也不能进入恢复流程。 */
export function validReviewCheckpoint(value: unknown): value is ReviewCheckpoint {
  if (!value || typeof value !== "object") return false;
  const checkpoint = value as ReviewCheckpoint;
  return ["text", "images", "complete"].includes(checkpoint.stage)
    && ["running", "paused", "complete"].includes(checkpoint.status)
    && typeof checkpoint.imageReview === "boolean"
    && (checkpoint.saveFailed === undefined || typeof checkpoint.saveFailed === "boolean")
    && (checkpoint.linkRepair === undefined || (!!checkpoint.linkRepair
      && Number.isFinite(checkpoint.linkRepair.attempts) && Number.isFinite(checkpoint.linkRepair.unresolved)));
}

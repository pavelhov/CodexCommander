import type { MediaSafeFailureCode } from "./media-errors";

/** Privacy-safe failure values which may be persisted in the media journal. */
export type SafeMediaFailure =
  | MediaSafeFailureCode
  | "download_rejected"
  | "job_failed"
  | "job_expired";

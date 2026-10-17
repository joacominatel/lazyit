import { ApiError } from "@/lib/api/client";

export type ArticleRestoreErrorKind = "slugTaken";

// Restore raises no 409 of its own, so one can only be P2002 on the live-slug index: the slug was reused.
export function articleRestoreErrorKind(error: unknown): ArticleRestoreErrorKind | null {
  return error instanceof ApiError && error.status === 409 ? "slugTaken" : null;
}

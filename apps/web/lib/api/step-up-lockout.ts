import { decisionErrorKind } from "@/lib/ai/error-kinds";

type Translate = (key: string, values?: { seconds: number }) => string;

// `t` is scoped to `ai.approval.errors`: the step-up backoff is shared, so its copy lives in one place.
export function stepUpLockoutMessage(error: unknown, t: Translate): string | null {
  const kind = decisionErrorKind(error);
  if (kind.kind !== "stepUpRateLimited") return null;
  return kind.retryAfterSec
    ? t("stepUpRateLimited", { seconds: Math.ceil(kind.retryAfterSec) })
    : t("stepUpRateLimitedNoTime");
}

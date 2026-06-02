import type { BatchResult } from "@lazyit/shared";
import { toast } from "sonner";

/**
 * Toast the per-id outcome of a batch (#104) mutation — `{ requested, succeeded, skipped }`. A fully
 * successful batch is a plain success toast; a partial one (some ids skipped — already in the target
 * state, already deleted/revoked, or not found) is a warning that names how many were skipped, so a
 * user understands why the table didn't change for every row they picked. The verb is the past-tense
 * action word ("deleted" / "restored" / "revoked" / "updated"). The single entry point for batch
 * toasts across the lists — pair it with {@link notifyError} in the mutation's `onError`.
 */
export function notifyBatchResult(
  result: BatchResult,
  { noun, verb }: { noun: string; verb: string },
): void {
  const succeeded = result.succeeded.length;
  const skipped = result.skipped.length;
  const label = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;

  if (skipped === 0) {
    toast.success(`${label(succeeded)} ${verb}.`);
    return;
  }
  if (succeeded === 0) {
    toast.warning(`No ${noun}s ${verb}. ${label(skipped)} skipped.`);
    return;
  }
  toast.warning(`${label(succeeded)} ${verb}; ${skipped} skipped.`);
}

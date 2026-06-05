import type { BatchResult } from "@lazyit/shared";
import { toast } from "sonner";
import type { EntityKey } from "@/lib/entity-key";

/** The past-tense batch action verbs the toasts support (drive the ICU `select` in `shared.batch.*`). */
export type BatchVerb = "deleted" | "restored" | "revoked" | "updated";

/**
 * Translator for the `shared` namespace — the caller passes its `useTranslations("shared")` so this
 * pure (non-React) util can resolve the locale-aware, correctly-pluralized batch grammar via ICU
 * instead of concatenating English literals (issue #204). `args` is left loose because next-intl's
 * translator is heavily overloaded; the call sites are all `useTranslations("shared")`.
 */
type SharedTranslator = (
  key: string,
  args?: Record<string, string | number | Date>,
) => string;

/**
 * Toast the per-id outcome of a batch (#104) mutation — `{ requested, succeeded, skipped }`. A fully
 * successful batch is a plain success toast; a partial one (some ids skipped — already in the target
 * state, already deleted/revoked, or not found) is a warning that names how many were skipped, so a
 * user understands why the table didn't change for every row they picked. The grammar is built from
 * the `shared.batch.*` ICU messages (count + entity noun + verb) — no string concatenation — so it
 * reads correctly in every locale. Pass the `entityKey` (closed set) and the past-tense `verb`; the
 * caller threads its `useTranslations("shared")` as `t`. The single entry point for batch toasts
 * across the lists — pair it with {@link notifyError} in the mutation's `onError`.
 */
export function notifyBatchResult(
  result: BatchResult,
  {
    entityKey,
    verb,
    t,
  }: { entityKey: EntityKey; verb: BatchVerb; t: SharedTranslator },
): void {
  const succeeded = result.succeeded.length;
  const skipped = result.skipped.length;

  if (skipped === 0) {
    toast.success(
      t("batch.allSucceeded", { count: succeeded, entity: entityKey, verb }),
    );
    return;
  }
  if (succeeded === 0) {
    toast.warning(
      t("batch.noneSucceeded", { skipped, entity: entityKey, verb }),
    );
    return;
  }
  toast.warning(
    t("batch.partial", {
      count: succeeded,
      skipped,
      entity: entityKey,
      verb,
    }),
  );
}

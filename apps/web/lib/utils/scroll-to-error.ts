/**
 * Scroll the first invalid field of a just-failed form submit into view and focus it.
 *
 * react-hook-form's `handleSubmit(onValid, onInvalid)` calls `onInvalid(errors, event)` when
 * validation fails. Pass `event?.target` (the submitted `<form>` — or any element within it): the
 * helper resolves the enclosing form and finds the first control carrying `aria-invalid="true"` in
 * DOM order (which matches reading order), then scrolls + focuses it. This guarantees the user is
 * taken to the first problem on submit, even when a tall form/dialog has scrolled the offending
 * field out of view.
 *
 * Framework-agnostic and dependency-free (queries the DOM by `aria-invalid`), so it works for any of
 * the converged forms/dialogs without each one wiring its own ref. Reads the DOM only inside a
 * deferred frame, never during render.
 */
export function scrollToFirstError(target: EventTarget | null): void {
  const el = target instanceof Element ? target : null;
  const formEl = el?.closest("form") ?? (el instanceof HTMLFormElement ? el : null);
  if (!formEl) return;
  // Defer one frame: `onInvalid` fires before React commits the re-render that sets
  // `aria-invalid="true"` on the newly-invalid controls, so query after the paint.
  requestAnimationFrame(() => {
    // `aria-invalid="true"` is set by every converged field on its control when its RHF fieldState
    // is invalid; the first one in DOM order is the first error.
    const firstInvalid = formEl.querySelector<HTMLElement>(
      '[aria-invalid="true"]',
    );
    if (!firstInvalid) return;
    firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
    // Focus after the scroll is queued; `focus({ preventScroll })` so it doesn't double-jump.
    firstInvalid.focus({ preventScroll: true });
  });
}

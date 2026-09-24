/**
 * Copy text to the clipboard, including on a plain-HTTP (`lan`) instance where the async Clipboard API
 * does not exist (it needs a secure context). Falls back to a throwaway off-screen field and the legacy
 * `execCommand('copy')` — the service-account secret-reveal precedent (#813). Returns whether it worked;
 * callers tell the user to select the text by hand when it did not.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Blocked or denied — fall through to the legacy path.
    }
  }
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.top = "0";
    field.style.left = "0";
    field.style.opacity = "0";
    field.style.pointerEvents = "none";
    document.body.appendChild(field);
    field.focus();
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  } catch {
    return false;
  }
}

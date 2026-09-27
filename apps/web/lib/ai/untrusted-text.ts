/**
 * Other-authored free text reaches the chat wrapped in `<untrusted_content>` (synthesis §4.3 — defence in
 * depth for the model, not markup for the browser). The web never renders it as HTML: it removes the
 * wrapper tags and shows the inner text as plain text, flagged so the UI can mark it as quoted content.
 */

const TAG = /<\/?untrusted_content\b[^>]*>/gi;

export interface CleanText {
  text: string;
  /** The value carried at least one untrusted wrapper. */
  untrusted: boolean;
}

export function stripUntrusted(value: string): CleanText {
  let untrusted = false;
  const text = value.replace(TAG, () => {
    untrusted = true;
    return "";
  });
  return { text, untrusted };
}

/** {@link stripUntrusted} for callers that only need the text. */
export function plainText(value: string): string {
  return stripUntrusted(value).text;
}

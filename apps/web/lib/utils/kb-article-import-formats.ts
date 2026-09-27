/**
 * The file types the server-side article import accepts (#1292). Kept beside
 * `kb-markdown-import.ts` — its client-side sibling — because the two are easy to confuse and the
 * confusion is what made `.docx` support invisible: the "New article" screen's drag-and-drop reads
 * the file IN THE BROWSER, so it can only take plain text, while the Import dialog uploads it and
 * the API extracts Markdown from a Word document (ADR-0021) or a whole archive (ADR-0059 §5).
 *
 * Mirrors `apps/api/src/articles/article-import.ts`; PDF is deliberately NOT supported (ADR-0021)
 * and nothing in the UI may imply otherwise.
 */

import { MARKDOWN_IMPORT_EXTENSIONS } from "./kb-markdown-import";

/** Extensions the Import dialog uploads, lowercase and with the dot. */
export const ARTICLE_IMPORT_EXTENSIONS = [
  ".md",
  ".markdown",
  ".txt",
  ".docx",
  ".zip",
] as const;

/** `accept` attribute for the Import dialog's file input. */
export const ARTICLE_IMPORT_ACCEPT = ARTICLE_IMPORT_EXTENSIONS.join(",");

/** Extensions the Import dialog takes that the in-browser dropzone cannot — the discoverability gap. */
export const UPLOAD_ONLY_IMPORT_EXTENSIONS = ARTICLE_IMPORT_EXTENSIONS.filter(
  (extension) =>
    !(MARKDOWN_IMPORT_EXTENSIONS as readonly string[]).includes(extension),
);

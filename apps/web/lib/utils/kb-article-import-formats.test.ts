import { describe, expect, it } from "bun:test";
import en from "@/messages/en/kb.json";
import es from "@/messages/es/kb.json";
import {
  ARTICLE_IMPORT_ACCEPT,
  ARTICLE_IMPORT_EXTENSIONS,
  UPLOAD_ONLY_IMPORT_EXTENSIONS,
} from "./kb-article-import-formats";
import { MARKDOWN_IMPORT_EXTENSIONS } from "./kb-markdown-import";

const CATALOGS = { en, es };

describe("article import formats", () => {
  it("uploads Word documents and archives, which the in-browser dropzone cannot read", () => {
    expect(ARTICLE_IMPORT_EXTENSIONS).toContain(".docx");
    expect(ARTICLE_IMPORT_EXTENSIONS).toContain(".zip");
    expect(MARKDOWN_IMPORT_EXTENSIONS).not.toContain(".docx");
    expect(UPLOAD_ONLY_IMPORT_EXTENSIONS).toEqual([".docx", ".zip"]);
  });

  it("offers every markdown extension the dropzone takes, so the two never disagree", () => {
    for (const extension of MARKDOWN_IMPORT_EXTENSIONS) {
      expect(ARTICLE_IMPORT_EXTENSIONS).toContain(extension);
    }
  });

  it("puts every accepted extension in the file picker's accept attribute", () => {
    expect(ARTICLE_IMPORT_ACCEPT.split(",")).toEqual([...ARTICLE_IMPORT_EXTENSIONS]);
  });
});

describe("import copy", () => {
  for (const [locale, kb] of Object.entries(CATALOGS)) {
    // #1292: the CEO asked for Word import that had shipped years earlier — it was working but
    // never named where a user looks before choosing a file. These two strings are that surface.
    it(`names .docx in the ${locale} import hint, before a file is chosen`, () => {
      expect(kb.import.description).toContain(".docx");
      expect(kb.import.fileHint).toContain(".docx");
      expect(kb.import.fileHint).toContain(".zip");
    });

    it(`sends the ${locale} dropzone hint to Import for the formats it cannot read itself`, () => {
      for (const extension of UPLOAD_ONLY_IMPORT_EXTENSIONS) {
        expect(kb.mdImport.uploadOnly).toContain(extension);
      }
    });

    it(`never claims PDF support in ${locale}`, () => {
      // PDF was deliberately deferred (ADR-0021) and is not being added.
      expect(JSON.stringify(kb).toLowerCase()).not.toContain("pdf");
    });
  }
});

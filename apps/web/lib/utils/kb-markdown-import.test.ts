import { describe, expect, test } from "bun:test";
import {
  filenameToTitle,
  MARKDOWN_IMPORT_MAX_BYTES,
  parseMarkdownImport,
  stripFrontmatter,
  validateMarkdownFile,
} from "./kb-markdown-import";

/**
 * Unit coverage for the KB drag-and-drop markdown import (#1106). Two things earn a test: the
 * drop-edge GUARD (a wrong type or an oversize file must be rejected — this is the trust boundary),
 * and the TITLE DERIVATION (frontmatter stripping + `# H1` vs filename fallback).
 */

describe("validateMarkdownFile", () => {
  test("accepts a .md file by extension even when the browser reports an empty mime", () => {
    expect(validateMarkdownFile({ name: "runbook.md", size: 10, type: "" })).toEqual({
      ok: true,
    });
  });

  test("accepts .markdown / .txt and a text/markdown mime", () => {
    expect(validateMarkdownFile({ name: "a.markdown", size: 1, type: "" }).ok).toBe(true);
    expect(validateMarkdownFile({ name: "a.txt", size: 1, type: "text/plain" }).ok).toBe(
      true,
    );
    // Extension unknown but mime says markdown → still accepted.
    expect(
      validateMarkdownFile({ name: "noext", size: 1, type: "text/markdown" }).ok,
    ).toBe(true);
  });

  test("rejects a non-markdown file with reason 'type'", () => {
    expect(
      validateMarkdownFile({ name: "photo.png", size: 10, type: "image/png" }),
    ).toEqual({ ok: false, reason: "type" });
  });

  test("rejects an oversize markdown file with reason 'size'", () => {
    expect(
      validateMarkdownFile({
        name: "huge.md",
        size: MARKDOWN_IMPORT_MAX_BYTES + 1,
        type: "text/markdown",
      }),
    ).toEqual({ ok: false, reason: "size" });
  });

  test("reports 'type' (not 'size') for a wrong file that is also oversize", () => {
    expect(
      validateMarkdownFile({
        name: "movie.mp4",
        size: MARKDOWN_IMPORT_MAX_BYTES + 1,
        type: "video/mp4",
      }),
    ).toEqual({ ok: false, reason: "type" });
  });
});

describe("stripFrontmatter", () => {
  test("removes a leading YAML frontmatter block", () => {
    const text = "---\ntitle: X\ntags: [a]\n---\n# Real heading\nbody";
    expect(stripFrontmatter(text)).toBe("# Real heading\nbody");
  });

  test("leaves text without frontmatter untouched", () => {
    expect(stripFrontmatter("# Heading\nbody")).toBe("# Heading\nbody");
  });

  test("does not strip an unterminated frontmatter fence", () => {
    const text = "---\ntitle: X\n# never closed";
    expect(stripFrontmatter(text)).toBe(text);
  });

  test("tolerates a leading BOM", () => {
    expect(stripFrontmatter("﻿---\ntitle: X\n---\nbody")).toBe("body");
  });
});

describe("filenameToTitle", () => {
  test("strips the final extension and trims", () => {
    expect(filenameToTitle("VPN Setup.md")).toBe("VPN Setup");
    expect(filenameToTitle("notes.backup.markdown")).toBe("notes.backup");
  });

  test("keeps a dotfile name (no stem before the dot)", () => {
    expect(filenameToTitle(".gitignore")).toBe(".gitignore");
  });
});

describe("parseMarkdownImport", () => {
  test("keeps content verbatim (frontmatter included) and derives the title from the H1", () => {
    const text = "---\ntitle: meta\n---\n# The Runbook\n\nSteps here.";
    const result = parseMarkdownImport(text, "whatever.md");
    expect(result.content).toBe(text); // content is the raw file text, unmodified
    expect(result.title).toBe("The Runbook"); // H1 after the frontmatter, not the filename
  });

  test("falls back to the filename when there is no H1", () => {
    const result = parseMarkdownImport("Just a paragraph, no heading.", "Office WiFi.md");
    expect(result.title).toBe("Office WiFi");
  });

  test("ignores an H2 and picks the first real H1", () => {
    const result = parseMarkdownImport("## Sub\n\n# Actual Title\n", "x.md");
    expect(result.title).toBe("Actual Title");
  });
});

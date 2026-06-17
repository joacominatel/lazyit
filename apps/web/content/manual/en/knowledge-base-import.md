---
title: Import
category: knowledge-base
subcategory: import
order: 5
---

# Import

You can bring existing documents into the Knowledge Base instead of retyping them — one file at a
time, or a whole tree of Markdown at once. Use **Import** from the Knowledge Base.

## Supported files

| File | What you get |
| --- | --- |
| `.md` / `.txt` | One article from the file's text |
| `.docx` (Word) | One article — the text is extracted to Markdown |
| `.zip` | **Bulk import** — many articles, see below |

Only the **text** is imported. The original file is **not stored**, and images and other binaries
inside a document are not kept.

When you import, you choose:

- a **Category** (the home folder the imported article(s) land in), and
- a **Status** — import as **Draft** (private to you) or **Published**.

Import is an article-write action and runs as the importing **person**, never as a service account.

## Single file

Pick a `.md`, `.txt` or `.docx` file, choose a category and status, and **Import**. The file is
processed and you are taken straight to the new article. Larger files take a moment.

## Bulk import from a `.zip`

A `.zip` lets you migrate an existing wiki — for example a folder of Markdown notes, or an exported
Obsidian or Notion vault — in a single upload.

- **Only `.md` and `.txt` entries are imported**, along with the archive's **folder structure**:
  nested folders in the zip are recreated as folders in the Knowledge Base, so the hierarchy comes
  across. Anything else (images, `.docx` inside the zip, hidden files, binaries) is **skipped, not
  treated as an error**.
- **`[[slug]]` wiki-links inside the imported notes are reconnected** to the freshly created
  articles where possible, so a cross-linked vault arrives already wired together rather than as a
  wall of dead links. A link that still has no target degrades to the usual "not created yet"
  mention.
- **Name clashes are resolved automatically.** If an imported article's slug is already taken, it is
  given a numbered suffix (`-2`, `-3`, …) rather than failing. Every rename is reported.

### Reading the results

A bulk import runs in the background and, when it finishes, shows a per-item summary so nothing is
silent:

- **Created** — articles imported cleanly.
- **Renamed** — imported, but the slug was auto-suffixed to avoid a clash (the requested name is
  shown).
- **Skipped** — entries that were not imported, with the reason (a folder entry, a hidden file, an
  unsupported type, or an empty file).

The summary also reports how many folders were created and how many wiki-links were reconnected.
Review it, then close the dialog — a bulk import does not navigate you away to a single article.

## Limits and safety

- There is a **maximum file size** for imports (a server setting; the default is small). An
  oversized file is rejected up front with a clear message.
- Archives are unpacked in a **sandboxed, memory-capped** process, so a malicious or accidentally
  enormous `.zip` (a "decompression bomb") cannot exhaust the server — it fails that one import
  safely and leaves everything else running. A failure of this kind is permanent for that file:
  fix or shrink the archive and import again.

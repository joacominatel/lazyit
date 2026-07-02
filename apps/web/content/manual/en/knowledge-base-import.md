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

The **text** is imported, and **images embedded in the document are carried over** as article
attachments (see [Embedded images](#embedded-images) below). The original file itself is **not
stored**, and non-image binaries are not kept.

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
## Embedded images

Images **embedded inside** an imported file are now brought across automatically, so a migrated
Word or Markdown runbook keeps its screenshots:

- A picture pasted into a **`.docx`**, or a base64 image embedded directly in **Markdown**, is
  extracted, saved as an article **attachment**, and shown inline in the imported article — the same
  way an image you paste into the editor is (see
  [Articles and authoring](/help/knowledge-base-articles-authoring)). This also applies to `.md`
  entries inside a `.zip`.
- **What is not brought across:** images **linked** from the web (`https://…`) are left as links and
  not shown (lazyit never fetches remote images); separate image **files** sitting alongside notes
  in a `.zip` are skipped; and drawings that aren't real raster images — **SVG** or HTML — are not
  imported. Export those to PNG first.
- Each image passes the **same checks as an editor upload**: its true type is verified, it is
  re-encoded (stripping camera/location metadata), and it counts against your instance's attachment
  **storage limit**. An image that can't be read is dropped from the article; if attachment storage
  is **full**, the whole import fails with a clear message — free space (or ask your administrator to
  raise the limit) and import again. Documents with a very large number of embedded images keep only
  the first several dozen.

References you write yourself to images already uploaded in lazyit (`attachment:` links) are kept
as-is.

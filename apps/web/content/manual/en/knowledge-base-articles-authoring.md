---
title: Articles and authoring
category: knowledge-base
subcategory: articles-authoring
order: 1
---

# Articles and authoring

The Knowledge Base is where your team keeps its **runbooks, procedures and notes** — your own
estate's documentation. It is separate from this Manual: the Manual documents *lazyit itself*, the
Knowledge Base documents *your servers, your apps, your processes*.

An **article** is a single Markdown document. You write it in plain Markdown, preview it as you go,
and publish it when it is ready.

## Writing an article

Open the Knowledge Base and choose **New article**. The form is short:

- **Title** — the article's name. The URL **slug** is derived from the title automatically (a short
  `lowercase-with-hyphens` form); you do not type it.
- **Category** — the article's home folder. Every article lives in **exactly one** folder. If you
  have not created any folders yet, use the **+** button to make one without leaving the form. See
  [Folders and access](/help/knowledge-base-folders-access).
- **Excerpt** *(optional)* — a one-line summary shown in listings.
- **Content** — the body, in Markdown.

The editor is a plain Markdown editor with a live preview — there is no rich-text/WYSIWYG mode by
design. Fenced code blocks are syntax-highlighted on the published page, each with a copy button,
and a ` ```mermaid ` block renders as a diagram. You write raw Markdown; the formatting appears when
the article is viewed.

While typing, two helpers offer autocomplete:

- Typing `[[` starts a **wiki-link** to another article — see
  [Linking and discovery](/help/knowledge-base-linking-discovery).
- Secret references to the Secret Manager are also supported inline; you only ever see and pick a
  handle, never a secret value.

### Formatting help (the `?` button)

A **`?` button** in the editor's toolbar opens a short **formatting cheat sheet** so you never write
"blind". It covers plain Markdown (headings, bold/italic, code, lists) and — most usefully —
lazyit's two **reserved tokens**, each with a copyable example:

- **Link another article** — `[[article-slug]]`, or `[[article-slug|Display text]]` for custom link
  text. A link to an article that does not exist yet stays a forward reference.
- **Reference a secret** — `{{ lazyit_secret.handle }}`, which renders as a masked chip only a vault
  member can reveal — see [Secret references](/help/secret-manager-secret-references).
- **External link** — a standard Markdown `[text](https://…)` link to anywhere outside the
  Knowledge Base.

Copy an example, paste it into the body, and the live preview shows exactly how the token resolves.
The same `?` and live preview are available on both the **New article** and **Edit** screens.

### Your work is protected

The editor guards against losing in-progress writing:

- **Local autosave** — as you type, your draft is saved to **this browser** every few seconds. It is
  a private safety net on your own machine, *not* a server save: the article only changes when you
  press **Create draft** / **Save changes**. If the tab crashes or closes by accident, nothing is
  lost.
- **Restore on return** — reopen **New article** or **Edit** and, if an unsaved local draft is
  waiting, a banner offers to **Restore** it (or **Discard** it). A saved article is never
  overwritten without your say-so.
- **Leave warning** — closing the tab, reloading, or pressing **Cancel** with unsaved edits asks you
  to confirm before discarding them. A successful save clears the local draft.

The local draft lives only in the browser you wrote it in; it is not shared with teammates or synced
across devices.

## Drafts and publishing

Every new article is born a **Draft**. A draft is **private to its author** — no one else can see
it, and a teammate who guesses its address gets an "article not found" page, not a permission error,
so the draft's very existence stays hidden.

Publish from the article itself:

- **Publish** — makes the article **Published** and visible to the team (subject to its folder's
  access rules). The first publish stamps a publish date that is never cleared.
- **Unpublish** — moves a published article **back to Draft**, hiding it from everyone but the
  author again.

A **Draft** badge marks unpublished articles on their page. Editing the body never changes the
published/draft state — publishing and unpublishing are their own explicit actions.

## Editing and deleting

- **Edit** opens the same form on the existing article. Saving updates the body; it does not change
  whether the article is published. Every edit that changes the title, body or excerpt is captured
  in the article's history — see [Versioning](/help/knowledge-base-versioning).
- **Delete** removes the article from the Knowledge Base. This is a **soft delete**: the row is
  retained, not erased, so it can be restored from the database if needed. Its slug is also freed so
  a new article can reuse the name.

## Who can do what

Authoring is gated by Knowledge Base permissions, and the API additionally enforces **authorship**:

- Reading the Knowledge Base needs the article-read permission, which every role holds by default.
- Creating, importing, editing, publishing, unpublishing and linking need the article-write
  permission. By default a normal writer may only edit, publish or delete **their own** articles — a
  write-permission holder who is not the author gets a permission error on someone else's article.
- **Editing any article.** Two callers are exempt from the author-only rule so a runbook is never
  stuck behind an unavailable author: **administrators** (who can always edit, publish, delete and
  restore any article), and holders of the **"Edit any article"** capability (`article:manage`). This
  is an admin-grantable permission you can give a trusted teammate. It bypasses authorship **only** —
  the person still needs the write permission to edit (or the delete permission to delete), and a
  non-admin holder still cannot touch an article in a folder they cannot see. **Attribution is never
  lost:** the original author stays recorded, and each edit is stamped with who actually made it in
  the article's version history.
- Administrators can always see every article, including drafts, regardless of folder restrictions.

See [Roles and permissions](/help/permissions) for the full capability set.

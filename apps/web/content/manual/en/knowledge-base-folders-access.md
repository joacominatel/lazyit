---
title: Folders and access
category: knowledge-base
subcategory: folders-access
order: 2
---

# Folders and access

Articles are organised into **folders** — a browsable tree, like a file system. Folders are also the
place where you control **who can read** which articles.

## Folders

Every article has **exactly one home folder**, chosen as its **Category** when you write it. Folders
can be nested, so you can build a tree such as `Servers / Linux / Provisioning`. Browse the tree
from the folder sidebar in the Knowledge Base.

- **Create a folder** from the **+** button on the article form (or where folders are managed) —
  give it a name and, optionally, a parent.
- **Names are unique within their parent.** `Servers / Linux` and `Workstations / Linux` can both
  exist; two folders named `Linux` under the *same* parent cannot.
- **Delete a folder** removes it and everything inside it — its sub-folders and all of their
  articles — from the Knowledge Base. The confirmation tells you exactly how many folders and
  articles are affected. The articles are soft-deleted (recoverable by an administrator from the
  database), but this is still a heavy action: read the warning before confirming.

To make an article *appear* in a second folder without moving its home, use an **alias** — see
[Linking and discovery](/help/knowledge-base-linking-discovery). An alias is navigation only and
never changes who can read the article.

## Access: public by default

A folder with **no access rule is Public**: every signed-in teammate who can read the Knowledge Base
sees its articles. This is the default, so nothing is hidden until you deliberately restrict a
folder. Access only ever **narrows** from public — a folder can never grant *more* than the Knowledge
Base already allows.

## Restricting a folder

Restricting access is an **administrator** action, done per folder from the folder's settings in the
sidebar. You add one or more **rules**; a person who matches **any** rule can read the folder (the
rules are combined with OR). The rule types are:

- **Users** — a named set of specific people.
- **Role** — everyone with a given role (Admins, Members or Viewers).
- **App grant** — anyone who currently has access to a chosen application. For example, *"whoever can
  use the Finance app may read its runbooks."*
- **Asset assignees** — whoever currently holds a chosen asset. For example, *"whoever has the
  on-call laptop sees its break-glass notes."*

The last two are **dynamic**: they read live access grants and asset assignments at the moment of
reading. Revoke someone's app access or release their asset and their Knowledge Base access
disappears automatically — there is no separate Knowledge Base permission to remember to remove when
someone leaves a project or the team.

A restricted folder shows a **lock** icon; a public one is open. Use **Make public** to remove all
rules and return a folder to the default.

### Restrictions are inherited downward

A sub-folder is **at least as restricted as its parent**. If a parent folder is restricted, its
children inherit that restriction; an administrator can add a rule on a child to narrow it *further*,
but never to widen it past the parent. A folder that has no rule of its own but sits under a
restricted parent shows as **Restricted (inherited from …)**, not Public.

## What restricted means for readers

When a folder is restricted, an article inside it is only readable if **all** of these hold:

1. You can read the Knowledge Base at all (the article-read permission).
2. The article's home folder is public, or one of its rules matches you, or you are an
   administrator.
3. The article is published, or it is your own draft.

If you fail the folder check, the article returns **"article not found"** — *not* a "permission
denied". This is deliberate: the server never reveals that a restricted article even **exists**, the
same way it hides other people's drafts. A document you may not see is simply, to you, not there.

## The guarantees behind the lock

A few rules are enforced by the server, not just shown in the interface:

- **Administrators see everything.** Folder restrictions scope what non-admins see; they never hide
  a document from an administrator. (This is visibility within the app — it is unrelated to the
  Secret Manager, where even an administrator cannot read an encrypted secret value.)
- **The padlock is real, not cosmetic.** Access is enforced at the server and database, never by the
  interface alone. A hidden article cannot be reached by a direct link, a second browser tab, or any
  other client — the lock holds everywhere, not just on the screen.
- **You can never surface what you cannot see.** You cannot alias, share, or otherwise expose an
  article you are not allowed to read yourself.

See [Roles and permissions](/help/permissions) for how roles and the article-read permission fit
together.

---
title: Linking and discovery
category: knowledge-base
subcategory: linking-discovery
order: 3
---

# Linking and discovery

The Knowledge Base connects articles to each other and to the estate they document, so a runbook is
never an island. There are three kinds of connection. On the reading page they gather in a calm
**Connections** rail beside the article (it moves below the article on narrow screens), and each
section appears **only when it has something to show** — an article with no connections is just its
prose. A companion **On this page** outline lists the article's headings and highlights the section
you are reading as you scroll.

## Wiki-links between articles

Inside an article's body, write `[[slug]]` to link to another article — the same Obsidian-style
link this product's own docs use. As you type `[[`, the editor suggests matching articles so you can
pick one.

- A `[[slug]]` whose target **exists** renders as a clickable link on the published page. Hover a
  working link to preview the target article — its title, status, folder and excerpt — without
  leaving the page.
- A `[[slug]]` whose target does **not exist yet** renders as a plain, non-clickable mention with a
  tooltip ("not created yet"). This is a **forward reference**: you can link a runbook you intend to
  write next. When you later create that article, the link starts working on its own — you do not
  re-edit the first article.

Saving an article never fails because of an unresolved `[[link]]`.

## References (backlinks)

The Connections rail shows a **Referenced by** section listing the articles that point **to it** via a
`[[slug]]` wiki-link (with a count). This is the reverse of the links above and the single most useful
way to navigate: from "the VPN cert rotation runbook" you immediately see every runbook that depends
on it. It appears only when at least one article references this one.

References are computed automatically from other articles' bodies — there is nothing to maintain by
hand. Mention an article as a `[[slug]]` somewhere and it appears in that article's References.

## Links to assets and applications

In the Connections rail, the **Linked to** section connects the article to your **inventory** — an
**asset** or an **application**. This is what makes the Knowledge Base IT-native: an article becomes
*"the runbook for THIS server"* or *"the access procedure for THIS app"*. When an article links to
anything, a compact **Covers** row of chips also appears under the title as an at-a-glance summary.

- Choose **Link**, pick a target type (Asset or Application), pick the specific record, and confirm.
  Each link points to **exactly one** target.
- The link is two-way. On the asset's or application's own page, a **Related articles** panel lists
  the published articles linked to it, so someone looking at the record finds its runbook.
- Remove a link from the same section.

Linking is an article-write action and, like editing, only the article's author can manage an
article's links. **Linked to** (article ↔ asset/application) and **Referenced by** (article ↔ article)
are two distinct things and live in two separate sections of the Connections rail — an article can
have both: the assets it documents *and* the runbooks that reference it.

## Search

Published articles are full-text searchable, including their **body** — not just titles and
excerpts. Drafts are never indexed, so a private draft can never surface in search. Restricted
folders are respected: search never reveals an article you are not allowed to read.

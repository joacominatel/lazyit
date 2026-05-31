# UX/UI — access management & knowledge-base screens

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Frontend / UX**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** Both surfaces are competent CRUD but miss their signature workflows: Access has no "who can access what" cross-view (no matrix, no per-user view, no Users detail page) and the KB lacks reading/authoring depth (no TOC, content-search, sanitizer, or toolbar).

## Findings (10)

### 1. No access matrix or per-user view — the Access pillar's core question is unanswered

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | large | high |

- **Location:** `apps/web/app/(app)/applications/page.tsx (whole screen); use-access-grants.ts:18; access-grants.controller.ts:60-72`
- **Why it matters:** ADR-0023 frames the pillar as 'who can access what,' but the UI is purely application-centric; offboarding/access-review are user-first and today require opening every app detail page. The data (all grants + users) is already fetched on the list, and the backend already filters GET /access-grants by userId, yet no screen passes it.
- **Recommendation:** Add a per-user access panel (useAccessGrants({userId,activeOnly:false}) grouped by app, with criticality + expiry) reachable from Users and from any avatar; then an apps×users access matrix as an Access sub-tab, built from data already on the list page, with critical rows weighted heavier.

### 2. Grant expiresAt and notes are not editable after creation despite backend PATCH endpoints

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | small | high |

- **Location:** `apps/web/lib/api/endpoints/access-grants.ts:43-63; apps/api/src/access-grants/access-grants.controller.ts:104-119; applications/[id]/page.tsx:200-247`
- **Why it matters:** ADR-0023:88-89 makes notes/revokedAt/expiresAt the only mutable fields precisely so they can be edited, but the web endpoints/hooks wire only create+revoke. Extending a contractor's access forces revoke+re-grant, fragmenting the audit trail. Expiry visibility is forensic (only an 'Expired' badge), not proactive.
- **Recommendation:** Wire updateExpiry/updateNotes into endpoints + use-access-grant-mutations; add inline edit on each active grant row and an 'Expiring soon' chip (e.g. <14 days) distinct from 'Expired'.

### 3. Markdown render has no sanitization layer — SEC-003 is a latent footgun the editor invites

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | medium | small | high |

- **Location:** `apps/web/components/markdown-view.tsx:14-30; markdown-editor.tsx:42`
- **Why it matters:** MarkdownView uses react-markdown+remark-gfm with no rehype-raw and no DOMPurify; raw HTML is escaped today (currently safe) but the only defense is an absence. The same component renders the live editor preview, so the first person who adds rehype-raw 'to make a table render' silently opens stored XSS on an app shell that also holds sensitive Access data. ADR-0029 mandates render-time sanitization.
- **Recommendation:** Add rehype-sanitize (or DOMPurify-on-output) with a strict allow-list (no script/event handlers, no javascript:/data: hrefs — mirror isSafeApplicationUrl) so enabling raw HTML later is safe-by-construction. <2h.

### 4. No Users detail page — the people directory is a dead-end list

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | medium | high |

- **Location:** `apps/web/app/(app)/users/ (only page.tsx, no [id]/); components/global-search.tsx`
- **Why it matters:** Users is a flat table; there is no /users/[id] route and global-search 'Users' hits navigate to the list, not a person. Asset-centric philosophy says people rotate, so offboarding needs a single 'everything tied to this person' page (access + assets + authored articles). This is the keystone that unlocks the per-user access view.
- **Recommendation:** Add /users/[id] with profile header, Access (grants via userId), Assets (assignments), and Authored articles; sequence it before the per-user access view.

### 5. KB reading experience is bare — no TOC, related articles, or reading aids

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | medium | medium | high |

- **Location:** `apps/web/app/(app)/kb/[slug]/page.tsx:108-198`
- **Why it matters:** The article view is a single column: title, meta, excerpt, MarkdownView. No TOC, no heading anchors, no related articles, no read-time, and lastEditedById (exists per ADR-0021:43) is never shown. IT KBs skew to long runbooks where navigability IS the reading experience; this stays within ADR-0021's simple-wiki mandate (render-layer only).
- **Recommendation:** Add a sticky right-rail TOC from the markdown headings with scroll-spy, a 'Related in {category}' footer (reuse useArticles({categoryId})), read-time, and 'Last edited by X' when it differs from author.

### 6. KB search is title-only and excludes content; Meili is wired but unused on the KB screen

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | medium | medium | high |

- **Location:** `apps/web/app/(app)/kb/page.tsx:42-52,98; endpoints/articles.ts`
- **Why it matters:** The KB list search box ('Search by title…') and server q match only title+excerpt (ADR-0021:48). Meilisearch already indexes articles for global search but the KB screen uses the substring filter, so a content query finds nothing unless the words are in a title — a KB you can't search by content is a filing cabinet.
- **Recommendation:** Point the KB search box at useSearch scoped to articles (Meili), keeping category/status as post-filters; confirm with CTO since docs still describe the list as LIKE-based (may need an ADR-0021 amendment).

### 7. Access request → approve queue has no UI scaffold or place in the IA

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | large | high |

- **Location:** `apps/web/components/sidebar-nav.tsx:20-30; ADR-0023:119-123`
- **Why it matters:** AccessRequest is deferred (ADR-0023:121, no model). The Access screen is admin-grant only with nothing in the nav anticipating a request/approval flow — the natural next Access workflow and the thing that turns a static inventory into an operated one. Designing the shape now avoids re-architecting the screens later.
- **Recommendation:** Reserve an Access sub-nav (Applications · Grants · Requests) and design an approval inbox (one-click approve creates a grant). Flag to CTO that this needs the AccessRequest model first.

### 8. Critical-app emphasis is a single small badge — under-weighted for the riskiest rows

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | quick-win | high |

- **Location:** `apps/web/app/(app)/applications/page.tsx:253-259; [id]/page.tsx:111-113`
- **Why it matters:** isCritical renders as one destructive badge in a column, visually equal to every other cell. Criticality is the only risk signal the Access model carries (ADR-0023:81); for a review, critical apps are where attention must land first, but the current treatment doesn't reward scanning.
- **Recommendation:** Give critical rows a full-row accent (left border/tint) + a shield/key icon and a 'critical first' default sort; optionally red-flag the grant count when critical AND has any expired-but-active grant.

### 9. Grant dialog shows no existing access for the chosen user and no level recall

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | small | high |

- **Location:** `apps/web/app/(app)/applications/_components/grant-access-dialog.tsx:114-157`
- **Why it matters:** Multi-grant is intentional (ADR-0023:50-52) so users aren't filtered out — correct — but the dialog gives no context ('Ada already has admin here') and accessLevel is a blank free-text input, so vocabularies drift (admin/Admin/administrator) with nothing to autocomplete, producing a messy audit trail.
- **Recommendation:** After a user is selected, show their current active grants on this app; turn accessLevel into a combobox suggesting levels already used on this application while still allowing free text.

### 10. Deactivated grantees are flagged on detail but invisible in the list avatars

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | quick-win | medium |

- **Location:** `applications/[id]/page.tsx:199,213-232 vs _components/stacked-user-avatars.tsx:14-37; page.tsx:224-228`
- **Why it matters:** Detail grays + badges soft-deleted grantees (gone = deletedAt != null), but StackedUserAvatars has no such treatment and the list's userById only maps active useUsers() results, so a grant to a departed user may silently drop from the stack. Offboarding is exactly where stale-grant signals should be louder, not hidden.
- **Recommendation:** Include inactive/soft-deleted users in the Access list's user map, gray their avatars, and badge an app row that has any active grant to a deactivated user ('N stale'), reusing the detail page's gone treatment.

## Quick wins

- Add a rehype-sanitize/DOMPurify pass to MarkdownView with a strict allow-list (closes SEC-003 by construction even while rehype-raw stays off) — markdown-view.tsx:28
- Heavier critical-app emphasis: full-row accent + icon + 'critical first' sort, no data changes — applications/page.tsx:222-271
- Copy-link and Copy/Download-as-markdown on the article detail (content already client-side; serves 'everything exportable') — kb/[slug]/page.tsx:108-163
- Gray + badge deactivated grantees in the Access list avatars, reusing the detail page's 'gone' treatment — stacked-user-avatars.tsx
- Show read-time and 'Last edited by' (lastEditedById already exists) in the article meta row — kb/[slug]/page.tsx:172-189
- Wire updateExpiry/updateNotes (API endpoints already exist) and add an 'Expiring soon' chip — endpoints/access-grants.ts, applications/[id]/page.tsx:200-247
- Hide/disable author-only Publish/Unpublish/Delete for non-authors instead of letting them fail server-side — kb/[slug]/page.tsx:117-162

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._

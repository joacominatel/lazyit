/**
 * Pure projectors: a domain row -> the flat search document indexed in Meilisearch (ADR-0035).
 *
 * Each function takes only the fields it needs (a structural subset of the Prisma row, so it works
 * for both the service sync calls and the reindex script) and returns a `{ id, ... }` document — the
 * `id` is the Meili primary key for every index. Only search-relevant fields are projected; the
 * documents are intentionally small (no relations, no large blobs). Nullable columns are passed
 * through as `null`. Pure and framework-agnostic so they can be unit-tested in isolation.
 */

export interface AssetRow {
  id: string;
  name: string;
  serial: string | null;
  assetTag: string | null;
  status: string;
  notes: string | null;
}

export interface ArticleRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  status: string;
  // The full Markdown body. Indexed so runbook bodies become findable (ADR-0042). Only PUBLISHED
  // articles are ever projected into the index (draft privacy — ADR-0022/0035), so indexing the
  // content of an author-private DRAFT is structurally impossible.
  content: string;
  // The article's HOME folder (= `Article.categoryId`). Carried into the index (ADR-0060 §5 search-leak
  // fix / INV-9) so the per-caller search post-filter can resolve each hit's home folder and DROP the
  // ones a non-matching caller may not see. Configured as a FILTERABLE attribute on the index; not part
  // of the retrievable hit fields (it is access metadata, not a hit field — see RETRIEVE in
  // search.service.ts).
  categoryId: string;
}

export interface UserRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface LocationRow {
  id: string;
  name: string;
  type: string;
  address: string | null;
  floor: string | null;
}

export interface ApplicationRow {
  id: string;
  name: string;
  vendor: string | null;
  description: string | null;
}

/** A projected search document — always carries the `id` primary key plus its searchable fields. */
export type SearchDocument = { id: string } & Record<string, unknown>;

export function projectAsset(row: AssetRow): SearchDocument {
  return {
    id: row.id,
    name: row.name,
    serial: row.serial,
    assetTag: row.assetTag,
    status: row.status,
    notes: row.notes,
  };
}

export function projectArticle(row: ArticleRow): SearchDocument {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    status: row.status,
    // Index the Markdown body so a full-text query over article content finds the runbook (ADR-0042).
    content: row.content,
    // Folder-access metadata (ADR-0060 §5): the home folder, a FILTERABLE attribute the post-filter
    // uses to drop a restricted hit a non-matching caller may not see. Never returned in a hit.
    categoryId: row.categoryId,
  };
}

export function projectUser(row: UserRow): SearchDocument {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
  };
}

export function projectLocation(row: LocationRow): SearchDocument {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    address: row.address,
    floor: row.floor,
  };
}

export function projectApplication(row: ApplicationRow): SearchDocument {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    description: row.description,
  };
}

import { apiFetch } from "./client";

/**
 * Builds the five standard REST data-access functions for a resource, given its
 * base path and — via explicit generics — its entity / create / update types.
 *
 * The generics are supplied at each call site, so every resource keeps fully
 * typed, per-resource functions; this only dedups the repetitive `apiFetch`
 * bodies, it does not erase type-safety. Resources with extra endpoints (e.g.
 * `publish`, `by-slug`) spread the result and add their own typed functions:
 *
 * ```ts
 * const base = createCrudEndpoints<Article, CreateArticle, UpdateArticle>("/articles");
 * export const getArticles = base.list;
 * export const publishArticle = (id: string) =>
 *   apiFetch<Article>(`/articles/${id}/publish`, { method: "POST" });
 * ```
 *
 * See ADR-0020. We deliberately stop the abstraction here (endpoints + keys) and
 * keep the TanStack hooks hand-written per resource — see the ADR for why.
 */
export function createCrudEndpoints<TEntity, TCreate, TUpdate>(base: string) {
  return {
    list: (): Promise<TEntity[]> => apiFetch<TEntity[]>(base),
    // `token` is the optional SSR Bearer override (ADR-0067): a Server Component prefetch passes
    // `session.accessToken` from `await auth()`, since the client token store is browser-only. Client
    // callers omit it and `apiFetch` falls back to the session-token store — behaviour unchanged.
    get: (id: string, token?: string): Promise<TEntity> =>
      apiFetch<TEntity>(`${base}/${id}`, { token }),
    create: (data: TCreate): Promise<TEntity> =>
      apiFetch<TEntity>(base, { method: "POST", body: data }),
    update: (id: string, data: TUpdate): Promise<TEntity> =>
      apiFetch<TEntity>(`${base}/${id}`, { method: "PATCH", body: data }),
    // Soft delete on the backend; returns the now-archived record.
    remove: (id: string): Promise<TEntity> =>
      apiFetch<TEntity>(`${base}/${id}`, { method: "DELETE" }),
  };
}

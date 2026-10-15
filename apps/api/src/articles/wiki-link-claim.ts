/** The `ArticleWikiLink` filter for the inbound edges an article takes over when it takes `targetSlug`. */
export interface ClaimableWikiLinkWhere {
  targetSlug: string;
  OR: Array<
    | { resolvedTargetId: null }
    | { resolvedTarget: { is: { deletedAt: { not: null } } } }
  >;
}

// Links follow the slug (ADR-0059 §3), so an edge still cached on a soft-deleted holder is as unresolved as a null one.
export function claimableWikiLinksWhere(
  targetSlug: string,
): ClaimableWikiLinkWhere {
  return {
    targetSlug,
    OR: [
      { resolvedTargetId: null },
      { resolvedTarget: { is: { deletedAt: { not: null } } } },
    ],
  };
}

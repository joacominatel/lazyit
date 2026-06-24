/**
 * The Help / Manual information-architecture MANIFEST (ADR-0062 §5, issue #563). This is the
 * single source of truth for the **importance ordering** of the nested IA: the categories in the
 * order they appear in the sidebar, and within each category its subcategories in order.
 *
 * Keys only — NO labels. Display labels live in i18n (`messages/<locale>/help.json`) under
 * `categories.<categoryKey>` and `subcategories.<categoryKey>.<subcategoryKey>`, so the same tree
 * renders localized en/es. Subcategory keys are SCOPED under their category (the loader/labels read
 * `<category>.<subcategory>`), so the same human name under two categories never collides.
 *
 * Frontmatter on each page carries the stable `category` + `subcategory` KEYS (kebab-case) plus an
 * `order` (sort within a subcategory). The loader (`lib/manual/loader.ts`) groups pages into this
 * tree, in this order, and renders ONLY the categories/subcategories that actually have ≥1 page —
 * so the sidebar grows as content lands and never shows an empty bucket. A page whose
 * category/subcategory isn't in this manifest sorts to the END (and dev-warns) rather than crashing.
 *
 * Web-only (ADR-0062 §2): the Manual has no API, no DB, no `@lazyit/shared` contract.
 */

/** One category in the manifest: its stable key plus its subcategory keys, both in importance order. */
export interface ManualNavCategory {
  /** Stable kebab-case category key — label lives at `categories.<category>` in `help.json`. */
  category: string;
  /** Stable kebab-case subcategory keys, in importance order — labels at `subcategories.<category>.<sub>`. */
  subcategories: string[];
}

/**
 * The frozen, importance-ordered IA tree (ADR-0062 §5). Transcribe EXACTLY — this same tree feeds
 * the parallel content agents. 13 categories; order is meaning (most important first).
 */
export const MANUAL_NAV: readonly ManualNavCategory[] = [
  {
    category: "getting-started",
    subcategories: ["introduction", "initial-setup", "users-team", "languages"],
  },
  {
    category: "assets",
    subcategories: [
      "asset-basics",
      "models-categories",
      "locations",
      "assignments-history",
      "asset-tags",
      "topology",
      "bulk-import",
    ],
  },
  {
    category: "users-permissions",
    subcategories: [
      "roles",
      "permissions",
      "permission-configuration",
      "service-accounts",
      "user-lifecycle",
    ],
  },
  {
    category: "applications-access",
    subcategories: [
      "applications",
      "access-grants",
      "criticality-alerts",
      "access-requests",
    ],
  },
  {
    category: "knowledge-base",
    subcategories: [
      "articles-authoring",
      "folders-access",
      "linking-discovery",
      "versioning",
      "import",
    ],
  },
  {
    category: "secret-manager",
    subcategories: [
      "vaults-members",
      "passwords-recovery-keys",
      "security-model",
      "secret-references",
    ],
  },
  {
    category: "consumables",
    subcategories: [
      "consumables-categories",
      "stock-movements",
      "low-stock-alerts",
    ],
  },
  {
    category: "access-automation",
    subcategories: [
      "concepts",
      "building-a-workflow",
      "manual-tasks",
      "testing-observability",
      "permissions",
      "troubleshooting",
    ],
  },
  {
    category: "notifications-activity",
    subcategories: [
      "notification-bell",
      "activity-reports",
      "global-search",
      "quick-view",
    ],
  },
  {
    category: "configuration",
    subcategories: [
      "instance-settings",
      "taxonomies",
      "asset-tag-scheme",
      "time-zone-formats",
      "search-index",
    ],
  },
  {
    category: "deployment-operations",
    subcategories: [
      "self-hosting",
      "services",
      "backups-restore",
      "identity-provider",
      "reverse-proxy-tls",
      "troubleshooting",
      "upgrades",
    ],
  },
  {
    category: "security-best-practices",
    subcategories: [
      "security-model",
      "access-control-principles",
      "operational-security",
      "recommended-patterns",
    ],
  },
  {
    category: "reference",
    subcategories: ["glossary"],
  },
] as const;

/**
 * Manifest membership lookup: category key → set of its subcategory keys. Lets the loader cheaply
 * detect a page whose `category`/`subcategory` aren't in the manifest (to dev-warn) without a scan.
 */
export const MANUAL_NAV_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  MANUAL_NAV.map((c) => [c.category, new Set(c.subcategories)]),
);

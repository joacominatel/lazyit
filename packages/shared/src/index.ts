// Barrel for @lazyit/shared — re-export every public contract from here.
// Organization: schemas/ (zod + inferred types), constants/, utils/ (pure fns), clone/ (pure fns).
// NOTE: the Secret Manager crypto primitives are intentionally NOT re-exported here. They live behind
// the SEPARATE `@lazyit/shared/crypto` subpath export (src/crypto/index.ts) because they import the
// ESM-only `@noble/*` packages — which apps/api's CommonJS Jest cannot load transitively (it would fail
// to parse every suite that touches this barrel). apps/api is a ciphertext custodian and never needs
// them; only apps/web (browser flows) and the crypto tests import them, via `@lazyit/shared/crypto`.
export * from "./clone/clone-defaults";
export * from "./clone/clone-user-payload";
export * from "./constants/app";
export * from "./schemas/access-grant";
export * from "./schemas/access-grant-list";
export * from "./schemas/api-error";
export * from "./schemas/application";
export * from "./schemas/application-category";
export * from "./schemas/article";
export * from "./schemas/article-alias";
export * from "./schemas/article-category";
export * from "./schemas/article-import-job";
export * from "./schemas/article-link";
export * from "./schemas/article-list";
export * from "./schemas/article-version";
export * from "./schemas/article-wiki-link";
export * from "./schemas/clone-user";
export * from "./schemas/asset";
export * from "./schemas/asset-assignment";
export * from "./schemas/asset-category";
export * from "./schemas/asset-expanded";
export * from "./schemas/asset-history";
export * from "./schemas/asset-list";
export * from "./schemas/asset-model";
export * from "./schemas/asset-model-list";
export * from "./schemas/asset-tag-scheme";
export * from "./schemas/application-list";
export * from "./schemas/batch";
export * from "./schemas/config";
export * from "./schemas/consumable";
export * from "./schemas/consumable-category";
export * from "./schemas/consumable-list";
export * from "./schemas/consumable-movement";
export * from "./schemas/dashboard";
export * from "./schemas/folder";
export * from "./schemas/location";
export * from "./schemas/location-list";
export * from "./schemas/notification";
export * from "./schemas/pagination";
export * from "./schemas/permission";
export * from "./schemas/permission-meta";
export * from "./schemas/primitives";
export * from "./schemas/recent-activity";
export * from "./schemas/search";
// Secret Manager — zero-knowledge vault wire shapes (ADR-0061, #366). PURE zod (base64 string blobs +
// metadata): these import NO `@noble/*` and NO `@lazyit/shared/crypto`, so apps/api's CommonJS Jest can
// load the barrel. The crypto PRIMITIVES stay behind the separate `@lazyit/shared/crypto` subpath.
export * from "./schemas/secret-item";
export * from "./schemas/secret-manager-views";
export * from "./schemas/secret-vault";
export * from "./schemas/user-keypair";
export * from "./schemas/vault-membership";
export * from "./schemas/service-account";
export * from "./schemas/user";
export * from "./schemas/user-history";
export * from "./schemas/user-list";
export * from "./schemas/workflow";
export * from "./utils/slug";
export * from "./utils/wiki-link";

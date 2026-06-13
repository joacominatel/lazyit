// Subpath entry for the Secret Manager crypto primitives — imported as `@lazyit/shared/crypto`.
//
// These are pure, framework-agnostic functions (no `window`/DOM/`.wasm`) but they pull in the ESM-only
// `@noble/*` packages. They are deliberately kept OUT of the main `@lazyit/shared` barrel (src/index.ts)
// so that apps/api's CommonJS Jest — which loads the main barrel transitively across most suites —
// never has to parse ESM from node_modules. apps/api is a ciphertext custodian and never imports these;
// only apps/web (the browser unlock/encrypt/decrypt flows) and the crypto unit tests consume them.
export * from "./aead";
export * from "./keys";
export * from "./params";
export * from "./recovery-key";

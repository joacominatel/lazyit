---
title: Getting started
order: 1
section: Getting started
---

> **Placeholder page.** This proves the Help/Manual pipeline end-to-end — routing, i18n,
> the en→es fallback, markdown rendering and the nav index. The REAL Phase-1 content
> (getting started, permissions, the Secret Manager, …) is tracked separately in issue
> **#536** and is OUT of scope for the scaffold (#535 / ADR-0062 Phase 1). Do not write
> full manual content here.

# Getting started

Welcome to the lazyit Manual — the product's own documentation, shipped with the code and
served from a **public, login-free** route (ADR-0062). It is distinct from the Knowledge
Base: the Manual documents *lazyit itself*, the KB documents *your estate*.

This page exists only to validate the scaffold. Note that Manual pages are plain product
markdown: KB-only tokens such as `[[some-slug]]` wiki-links and `{{ lazyit_secret.HANDLE }}`
secret chips render as **literal text here**, never as live elements — the Manual is
secret-free by construction.

---
title: Recommended patterns
category: security-best-practices
subcategory: recommended-patterns
order: 4
---

# Recommended patterns

A short, opinionated set of habits that keep a lazyit instance tidy and safe. None of these are
enforced — they're the patterns that work well for a small IT team.

## Name things so the name leaks nothing

Some labels in lazyit are **visible to more people than the data behind them**. In the Secret Manager,
a vault's **name** and **member list**, and a secret's **label**, are visible as metadata even though
the secret *value* is encrypted and unreadable by the server. So:

- **Name a vault for its scope, not its contents** — "Production network gear", not the actual
  password.
- **Label a secret by what it is** — "Core switch admin login" — never by putting the value in the
  label.

The same instinct applies across the product: choose names that are useful to a teammate but
harmless to a casual reader.

## Knowledge Base folders: structure access, don't sprinkle it

Knowledge Base access is scoped to **folders**, not individual articles. Lean into that:

- **Decide access at the folder level.** Put articles that share an audience in the same folder and
  set the folder's access once, rather than trying to reason about each article.
- **Inherit, then narrow.** A sub-folder can be more restricted than its parent but never wider —
  build your tree so the most sensitive material sits deeper, under a tighter folder.
- **Default to open for general runbooks; restrict the few that need it.** Most documentation
  benefits from being findable. Reserve restricted folders for the genuinely sensitive.
- **Remember that links don't widen access.** Referencing or linking an article never lets someone
  see something they otherwise couldn't — so organize for clarity, and let the access rules do the
  gating.

## Vault membership hygiene

Vaults are the unit of secret sharing — treat membership as something you curate, not something that
just accumulates:

- **Never leave an important vault with one member.** A single-member vault is one lost recovery key
  away from permanent loss. Add a second trusted member to anything that matters; heed lazyit's
  single-member warning.
- **Scope a vault to a real group.** A vault for "the network team" with the right members beats one
  giant vault everyone is in. Smaller membership means a smaller blast radius if one member is
  compromised.
- **Review membership when people change roles or leave.** Removing a member stops their future
  access. If the secret itself may have been exposed, also **rotate the underlying credential** — see
  [Operational security](/help/security-best-practices-operational-security).
- **Share by adding members, not by copying secrets around.** The whole point of a vault is that you
  grant access without the value ever leaving its encrypted form.

## Delegation: prefer specific permissions over big roles

When someone needs to do a little more than their role allows, resist the urge to make them an
administrator:

- **Grant the specific permission to Member or Viewer** rather than promoting to admin. Administrator
  is all-or-nothing and can't be narrowed.
- **Keep the administrator group small and reviewed.** A handful of admins is healthier than a dozen.
- **Use a service account for automation**, not a human's credentials or a shared admin login. Give
  each one its own narrowly scoped token, and rotate it if exposed.

See [Access-control principles](/help/security-best-practices-access-control-principles) for the
reasoning behind these, and [Permissions](/help/permissions) for how to actually adjust what Member
and Viewer can do.

## A one-line summary

**Least access, off-host recovery keys, multi-member vaults, harmless names, and rotate the real
credential when in doubt.** Get those five right and the rest follows.

---
title: Languages
order: 1
category: getting-started
subcategory: languages
---

# Languages

lazyit ships in two languages: **English** and **Español**. English is the default. The choice is a
personal preference stored in your browser, not an instance-wide setting — each person picks their own,
and it does not change anyone else's.

## Switching language

There are two places to switch, depending on where you are:

- **On public pages** (this Manual, the sign-in page) — use the **globe** button in the top bar and
  pick **English** or **Español** from the menu. No sign-in needed.
- **Once signed in** — open your **user menu** in the top-right and use the language sub-menu (the
  globe row) to pick your language.

The change applies immediately — the page re-renders in the chosen language. There is no separate
"save" step.

## How it is remembered

Your choice is stored in a long-lived browser cookie (`NEXT_LOCALE`), so lazyit keeps showing you the
same language on your next visit. A few things follow from that:

- **It is per-browser, per-device.** Switching on your laptop does not change the language on your
  phone, and a different person on the same instance keeps their own choice.
- **The web address never changes.** lazyit does not add a language prefix (such as `/es/`) to URLs —
  the same link works regardless of the language you have chosen.
- **Clearing cookies resets it.** If you clear your browser's cookies, lazyit falls back to the
  default, English, until you pick again.

## What gets translated

The lazyit interface and this Manual are fully translated. Your own content — asset names, Knowledge
Base articles, notes you type — is shown exactly as you entered it; lazyit does not translate the data
you put in.

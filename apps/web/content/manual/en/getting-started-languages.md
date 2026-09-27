---
title: Languages
order: 1
category: getting-started
subcategory: languages
---

# Languages

lazyit ships in two languages: **English** and **Español**. English is the default. The choice is a
personal preference, not an instance-wide setting — each person picks their own, and it does not change
anyone else's.

## Switching language

There are two places to switch, depending on where you are:

- **On public pages** (this Manual, the sign-in page) — use the **globe** button in the top bar and
  pick **English** or **Español** from the menu. No sign-in needed.
- **Once signed in** — open your **user menu** in the top-right and use the language sub-menu (the
  globe row) to pick your language, or use **Language** in the **Preferences** panel of **Account**.

The change applies immediately — the page re-renders in the chosen language. There is no separate
"save" step.

## How it is remembered

Your choice is stored in a long-lived browser cookie (`NEXT_LOCALE`), so lazyit keeps showing you the
same language on your next visit. A few things follow from that:

- **Your browser's choice wins.** Switching on your laptop does not change the language on a phone
  where you already picked one, and a different person on the same instance keeps their own choice.
- **It follows you to a new browser.** When you switch while signed in, lazyit also saves the choice
  on your account. A browser that has no choice of its own — say, the first sign-in on a new phone —
  starts in that language. See [Your profile](/help/getting-started-your-profile#your-language-and-theme-on-every-device).
- **The web address never changes.** lazyit does not add a language prefix (such as `/es/`) to URLs —
  the same link works regardless of the language you have chosen.
- **Clearing cookies resets it.** If you clear your browser's cookies, lazyit falls back to the
  default, English — or, once you sign in, to the language saved on your account.

## What gets translated

The lazyit interface and this Manual are fully translated. Your own content — asset names, Knowledge
Base articles, notes you type — is shown exactly as you entered it; lazyit does not translate the data
you put in.

---
title: Time zone & formats
category: configuration
subcategory: time-zone-formats
order: 4
---

# Time zone & formats

lazyit shows dates and times in **one instance-wide time zone**, and formats them according to the
active interface language. Both are sensible by default; the time zone is the one you may want to set.

## Setting the display time zone

Because lazyit is single-org and self-hosted, the whole instance displays times in a **single zone** —
there is no per-user time zone. You set it with the `NEXT_PUBLIC_DEFAULT_TIME_ZONE` environment
variable on the web service:

```
NEXT_PUBLIC_DEFAULT_TIME_ZONE=America/Argentina/Buenos_Aires
```

- It accepts any **IANA** zone name (for example `UTC`, `Europe/Madrid`,
  `America/Argentina/Buenos_Aires`).
- If you don't set it, lazyit defaults to **`UTC`**.
- The setting takes effect when the web service starts, so change it in your deployment config and
  restart (or redeploy) the web service.

> Set this to your team's actual zone. With the `UTC` default, every timestamp is shown in UTC — which
> is correct but off by your local offset, so a 9:00 event may read as 12:00. Configuring the zone once
> makes every date and time across the app — dashboards, reports, activity history, the notification
> bell, asset history — read in local time.

This is an instance-wide display setting only. It changes how moments are **shown**; it does not change
the underlying data, which is always stored as an absolute moment in time.

## How dates and times are formatted

The **format** (the way a date is written) follows the **interface language**, not the time zone. The
same moment renders in the conventions of the chosen language:

- A compact date is used in tables and lists — for example *May 25, 2026* in English, *25 may 2026* in
  Spanish.
- An absolute date with a time accompanies audit-relevant rows — for example *May 25, 2026, 3:04 PM* —
  so a row that records when something happened always carries the exact moment.

Relative phrasing (such as "2 hours ago") is used where recency matters, with the absolute date and
time available on hover or to assistive technology, so the precise moment is never lost. To change the
formatting language, switch the interface language; see
[Languages](/help/getting-started-languages).

---
title: Backups & Disaster Recovery
tags: [runbook, database, backups, disaster-recovery]
status: accepted
created: 2026-05-25
updated: 2026-10-21
---

# Runbook — backups & disaster recovery

How to back up **everything lazyit needs to survive disk loss**, and how to restore it in the
right order. lazyit holds sensitive inventory/access data on a single host
([[0015-deployment-model]]); a working, tested restore is mandatory before real use.

> [!danger] The #1 DR mistake: a dump without its `.env.prod`
> The prod stack runs **one** Postgres database — the app DB — plus secrets in `.env.prod`. A dump
> restored **without the matching `.env.prod`** comes back with the wrong database password and, worse,
> without the `WORKFLOW_SECRET_KEY` that decrypts every stored connector credential. Back up the two
> together, and restore them together. The same goes for the **attachments tarball** (item #7): the dump
> holds the `attachments` rows, the tarball holds their bytes, and the sidecar writes them as a pair
> under one timestamp — keep and restore the pair. Under OIDC (BYOI) the identities live in **your**
> IdP, which you back up by its own procedure (item #3). "I restored the backup and nothing works" is the
> worst DR outcome — this runbook exists to prevent it.
>
> lazyit no longer ships an IdP ([[0102-remove-bundled-zitadel]]). An install that still runs the
> bundled Zitadel follows [[migrate-off-bundled-zitadel]], which covers its database and master key.

## What to back up (DR inventory)

| # | Item | Where | Back up? | How to recover if lost |
| - | --- | --- | --- | --- |
| 1 | **`infra/env/.env.prod`** | host file (gitignored) | **YES — off-host, encrypted** | Irreplaceable. Holds the DB password and `WORKFLOW_SECRET_KEY` — the unrotatable DR linchpins — plus `AUTH_SECRET`, `SMTP_SECRET_KEY`, `AI_SECRET_KEY` and `DIRECTORY_SECRET_KEY` (all optional and low-DR — see below), the OIDC client secret (BYOI), and (local mode) `SESSION_SIGNING_SECRET` (low-DR, rotatable — see below). |
| 2 | **App database** | `db` (Postgres 18, `db_data` volume) | **YES — `pg_dump`** | Restore from dump. In **local-auth mode** this also carries the user **password hashes** (argon2id `passwordHash`) — no separate auth store to back up. |
| 3 | **Your OIDC IdP** (BYOI only) | outside lazyit — the provider you run or subscribe to | Yes, by **the IdP's own** procedure — lazyit does not back it up | Restore it with its users intact. lazyit binds each person to the IdP's subject (`sub`); an IdP rebuilt with new `sub`s does not map onto the existing people ([[auth-bootstrap]] §5). |
| 4 | Meilisearch index | `meili_data_v1_53_2` volume (named per server version) | No (rebuildable) | Nothing to do: on boot the API rebuilds any empty/missing index from the database; `reindex:all` forces a full rebuild ([[0035-search-architecture]]). |
| 5 | Caddy TLS state | `caddy_data` / `caddy_config` volumes | No (re-issuable) | Caddy re-obtains certs from Let's Encrypt (or re-mints its internal CA) automatically. |
| 6 | **Secret Manager vault values** | App database (rows in `secret_vaults` / `secret_items` / `vault_memberships` / `user_keypairs`) | Covered by item #2 (**no extra backup needed**) | Zero-knowledge: a DB restore brings back ciphertext + wrapped DEKs. Values are readable only by a surviving member's vault passphrase or off-host recovery key — the server cannot re-enter them, unlike `WORKFLOW_SECRET_KEY`. See below. |
| 7 | **File attachments (blobs)** | `attachments_data` volume (asset documents, **purchase documents** — invoices, orders, delivery notes — and KB inline images, [[0082-attachments-storage]]) | **YES — tarball** (`attachments-<ts>.tar.gz`, written by the backup sidecar right after `app-<ts>.dump`, #1467) | Restore the tarball **from the same run as the DB dump**, after the DB and before the api starts (*Restore order* below). `pg_dump` captures only the `attachments` metadata rows (item #2), never the bytes — without the tarball the rows come back pointing at missing files. |

> [!warning] `WORKFLOW_SECRET_KEY` is an unrotatable linchpin (ADR-0054)
> The Applications Workflow Engine encrypts every stored connector credential (`WorkflowSecret`,
> AES-256-GCM) with this key. A DB restore **without the matching `WORKFLOW_SECRET_KEY`** yields
> **undecryptable connector credentials** — the workflow data restores fine, but the engine can no
> longer read any saved secret (recoverable only by re-entering them by hand). It is unrotatable,
> lives in item #1 (`.env.prod`), and must be backed up off-host with the *matching* DB dump. Never
> generate a fresh one on a restore, and never let `.env.prod` be your *only* copy of it.

> [!warning] `SMTP_SECRET_KEY` is a *fourth* server-held master key — but OPTIONAL and trivially recoverable (ADR-0079)
> The instance SMTP password (Settings → Email) is encrypted at rest (`SmtpSettings`,
> AES-256-GCM) under `SMTP_SECRET_KEY` — its own key axis, SEPARATE from `WORKFLOW_SECRET_KEY` ("one key
> per subsystem"). A DB restore **without the matching `SMTP_SECRET_KEY`** yields an **undecryptable SMTP
> password**: outbound email stops until an admin re-enters the password in the UI. Unlike the
> linchpins above, this key is **OPTIONAL** (unset ⇒ the app boots fine and email is simply unavailable)
> and the loss is **cheap to recover** (one field, re-typed by an admin) — so it is a "nice to back up
> alongside `.env.prod`", not a DR linchpin. Keep it with the same off-host copy of `.env.prod` for
> zero-touch restores; regenerating it just means re-entering one SMTP password.
>
> A guided install **generates this key** (`infra/start.sh`, issue #1269) — so it is in `.env.prod` from
> day one and an admin can save an authenticated SMTP password without hand-editing anything.
> `--reconfigure` **preserves an already-present key verbatim** and only mints one when the file carries
> none (nothing can be encrypted under a key that was never there). A `.env.prod` predating that change
> has no key: re-running `./infra/start.sh` on the existing install appends one (any auth mode, backup
> first — ADR-0047 amendment 2026-09-26), as does `./infra/start.sh --reconfigure`; or append one by hand and recreate the api
> container — see **[[deploy-self-hosted]]**. Never regenerate a key that is already in the file: the
> stored SMTP password becomes undecryptable and must be re-typed.

> [!info] `AI_SECRET_KEY` — the AI provider key's at-rest key: OPTIONAL and low-DR, like `SMTP_SECRET_KEY` (ADR-0097)
> When an admin configures the AI assistant (Settings → AI), the provider's API key is stored encrypted
> (AES-256-GCM) under `AI_SECRET_KEY` — its own key axis, separate from `SMTP_SECRET_KEY` and
> `WORKFLOW_SECRET_KEY`. **Back it up alongside `SMTP_SECRET_KEY`**, in the same off-host copy of
> `.env.prod`. A DB restore **without the matching key** leaves the stored provider key undecryptable:
> the assistant stops reaching its provider until an admin re-enters the API key — nothing else is lost
> (conversations, the AI action ledger and MCP connections live in the app DB, item #2). The key is
> **optional** (unset ⇒ the app boots unchanged and only saving a provider API key 409s), so it is not a
> DR linchpin. A guided install, `./infra/start.sh --reconfigure`, and a re-run of `./infra/start.sh` on
> an existing install that lacks it write it; all of them preserve a present key verbatim. Never
> regenerate a key that is already in the file.
>
> Restoring a `.env.prod` backup **older than the key** onto a database whose stored secret was encrypted
> under it: a re-run of `start.sh` sees the key missing and mints a fresh one, so that stored SMTP password
> or provider key stays undecryptable — exactly as it would with no key at all — and an admin re-enters
> it. This is why the off-host copy of `.env.prod` should be refreshed whenever `start.sh` reports it
> added a key.
>
> **AI conversations outlive their retention in your dumps.** The app deletes a conversation for good
> after the retention an admin sets (default 90 days) or when its owner deletes it — but a dump taken
> before that still holds it until the dump itself is pruned (`BACKUP_RETENTION_DAYS`, or your off-host
> copy's own retention). Restoring an old dump brings those transcripts back until the next retention
> sweep. Keep backup retention in line with what your organization expects of AI transcripts.

> [!info] `DIRECTORY_SECRET_KEY` — the LDAP bind password's at-rest key: OPTIONAL and low-DR, like `SMTP_SECRET_KEY` (ADR-0091)
> When an admin configures directory sync (Settings → Directory), the read-only LDAP
> **bind password** is stored encrypted (AES-256-GCM) under `DIRECTORY_SECRET_KEY` — its own key axis,
> separate from `SMTP_SECRET_KEY`, `AI_SECRET_KEY` and `WORKFLOW_SECRET_KEY`. **Back it up alongside
> them**, in the same off-host copy of `.env.prod`. A DB restore **without the matching key** leaves the
> stored bind password undecryptable: the scheduled sync and *Sync now* fail to bind until an admin
> re-types the password — the imported people and their history live in the app DB (item #2) and are
> untouched. The key is **optional** (unset ⇒ the app boots unchanged; only saving a connection *with* a
> bind password 409s, and that rejects the whole save), so it is not a DR linchpin.
>
> A guided install **generates this key** (`infra/start.sh`, issue #1271), and `./infra/start.sh
> --reconfigure` and a re-run of `./infra/start.sh` on an existing install that lacks it add it; all of
> them **preserve a present key verbatim**, whatever encoding it uses. Nothing can have been encrypted
> under a key that was never set, so adding one orphans nothing. **Never regenerate a key that is
> already in the file**: the stored bind password becomes undecryptable and must be re-typed. The same
> restore caveat as above applies — a `.env.prod` backup older than the key, restored onto a database
> holding a bind password encrypted under it, gets a fresh key from `start.sh` and the password must be
> re-entered — so refresh the off-host copy whenever `start.sh` reports it added a key.

> [!warning] Attachments (item #7): the dump and the tarball are ONE backup — keep the pair
> [[0082-attachments-storage]] puts uploaded files (warranty PDFs, receipts, damage photos, KB images,
> and the purchase documents — invoices, orders, delivery notes, financial evidence per
> [[0099-purchases-scope-model-and-optionality|ADR-0099]] §12) on the `attachments_data` **filesystem
> volume**, which no `pg_dump` captures. The backup sidecar archives that volume on every run (#1467):
> `attachments-<ts>.tar.gz`, taken right after `app-<ts>.dump` and named with **the same `<ts>`**.
>
> - **Why DB first, then blobs.** Uploads write the blob before its row ([[0082-attachments-storage]]
>   §3), so every row in the dump already has its blob on disk when the tarball starts. The window
>   between the two is the tarball's own run time; a file uploaded inside it is in the tarball but has
>   no row in the dump, and the GC reclaims it after a restore. The one way to get a row without its
>   blob is a delete **and** the GC's daily sweep both landing in that window — that file then shows as
>   missing (a 404, never a crash: rows are soft references).
> - **Restore the pair, DB first, api down** ([[#Restore order (full DR — host rebuilt from scratch)|restore order]]).
>   The attachments GC removes blobs **no row references** once they are older than 24 h, and restored
>   blobs keep their original mtime. Start the api against a DB that lacks those rows — an empty one, or
>   a much older dump — and its next sweep deletes the restored files.
> - **Rolling back to an older dump** (e.g. `update.sh`'s pre-update backup) onto the current volume:
>   files uploaded after that dump have no row in it, so the GC removes them after the grace — the same
>   uploads the older dump has no record of.
> - The tarball is a **full copy each run** (blobs are mostly PDFs, images and Office files that are
>   already compressed, so it is about the size of the volume), so it has its **own, shorter retention**
>   — `BACKUP_ATTACHMENTS_RETENTION_DAYS`, default 7 against the dumps' 14. A restore needs the pair, so
>   only the last 7 days of runs are full pairs; older dumps restore without their files. See
>   [[#Disk space and run time]].
> - **Opting out** (`BACKUP_ATTACHMENTS=false`) — for an operator who backs the volume up another way
>   (host or volume snapshots). The dump still runs; the files are then **your** responsibility.

> [!info] `SESSION_SIGNING_SECRET` (local-auth mode) is rotatable and LOW-DR — not a linchpin (ADR-0086)
> In **local-auth mode** (`AUTH_MODE=local`) the API signs its first-party session tokens (HMAC) with
> `SESSION_SIGNING_SECRET`. It is **required at boot** (≥32 chars, fail-loud like `WORKFLOW_SECRET_KEY`)
> but it is **NOT a DR linchpin**: it encrypts/authenticates nothing at rest. Losing or rotating it only
> **invalidates live sessions** — every user simply logs in again with their existing password (the
> `passwordHash` lives in the app DB, item #2). So it is *not* the `WORKFLOW_SECRET_KEY`
> severity class — a restored app DB is fully usable with a **fresh** signing secret. Keep it in `.env.prod`
> (item #1) for zero-touch restores, but its loss costs one re-login, not any data. Unused in OIDC mode.

> [!info] Automation: the backup sidecar (see below)
> Items #2 and #7 are automated by the `backup` service in the canonical `compose.yaml` (cron +
> `pg_dump` + a tarball of the attachments volume to a host-mounted `./backups`, with retention). It
> runs the same way in every auth mode. Item #1 is **your responsibility** — `.env.prod` must be copied
> off-host manually and access-controlled — and so is item #3.

> [!warning] The Secret Manager BREAKS the "restore DB + matching env key ⇒ everything readable" model
> Everything above assumes the recovery rule "**a DB dump + the matching `.env.prod` key makes the data
> readable again**" — true for the app DB and for the workflow engine's connector secrets
> (`WORKFLOW_SECRET_KEY`). The **Secret Manager** ([[0061-secret-manager-zero-knowledge]])
> is the deliberate exception: it is **zero-knowledge** (**INV-10**), so its decryption keys are
> **USER-held — a member's vault passphrase plus their one-time recovery key — and are NEVER in `.env.prod`** (no
> server-side master key exists over secret *values*). Consequences for DR:
> - A perfect **DB + `.env.prod` restore does NOT make zero-knowledge vaults readable.** The restored rows
>   hold only ciphertext and per-member DEK copies wrapped to each member's public key; the server cannot
>   unwrap any of them. Vault values come back only when a surviving member logs in (decrypts their wrapped
>   DEK with their vault passphrase) **or** a surviving member redeems **their own** recovery key (which
>   unlocks **their** private key → the vault DEK).
> - The **recovery key is the user's personal, off-host, shown-once DR artifact** — the Secret-Manager
>   analogue of `WORKFLOW_SECRET_KEY`, but **per user, not in any backup the operator controls**. It is shown
>   once at keypair creation, never logged, never persisted in clear ([[0031-logging-strategy]]); the
>   operator cannot back it up *for* the user. Document the "store your recovery key off-host" duty as part
>   of onboarding, not as an operator backup item.
> - **A single-member vault that loses BOTH the member's vault passphrase AND their recovery key is permanent loss
>   — by design.** No DB restore, no env key, and no ADMIN can recover the plaintext (INV-8 ADMIN-omnipotence
>   is over authorization/visibility, never cryptographic plaintext). Mitigation is organizational: keep
>   sensitive vaults **multi-member** so a peer can re-wrap the DEK to a reset member.
>
> This sits **beside**, not inside, the env-key model: contrast the server-decryptable [[workflow-secret]]
> store (recoverable with `WORKFLOW_SECRET_KEY`) against the Secret Manager (no operator-recoverable key at
> all). See [[0061-secret-manager-zero-knowledge]].

All commands run from the repo root, against the prod-like / self-hosted stack (the consolidated
`compose.yaml` + `infra/docker-compose.prod.yaml` + `--profile prod`; the old
`-f infra/docker-compose.prod.yml` form is superseded — [[deploy-self-hosted]]). Postgres is not
published to the host ([[0028-secrets-and-config]]), so backups run *inside* the compose network via
`docker compose exec`. Shorthands:

```sh
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod"
PG="$DC exec -T db"          # app DB
```

## Manual backup

```sh
# App DB. POSTGRES_USER/DB come from the container env (.env.prod). Custom format (-Fc) is
# compressed and supports selective restore.
$PG sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "app-$(date +%Y%m%d-%H%M%S).dump"

# Attachments — AFTER the dump (see item #7). Read through the backup service's read-only mount;
# tmp/ holds only in-flight uploads and is left out.
$DC --env-file infra/env/.env.prod run --rm --no-deps -T backup \
  sh -c 'tar -czf - -C /attachments --exclude ./tmp .' > "attachments-$(date +%Y%m%d-%H%M%S).tar.gz"
```

This writes a timestamped `app-*.dump` and `attachments-*.tar.gz` to the current directory. **Copy
them off the host** to a secure, access-controlled location, **together with `infra/env/.env.prod`**
(the connector credentials in the dump are unreadable without the `WORKFLOW_SECRET_KEY` it holds).

With the sidecar running, `$DC exec -T backup lazyit-backup` does one full run now instead — the same
verified, matched pair the schedule writes, into `./backups`.

> [!tip] Plain SQL alternative
> Drop `-Fc` and redirect to `*.sql` for a human-readable dump; restore it with `psql` instead of
> `pg_restore`.

> [!note] gitignore the dumps
> `*.dump`, `*.sql`, `*.tar.gz` and the sidecar's `./backups/` are **not** auto-ignored by the repo's
> `.gitignore`. If you keep backups inside the working tree, add them to `.gitignore` so a stray
> `git add` never commits a file full of secrets or invoices.

## Automated backup — the sidecar

The `backup` service runs cron. Each run dumps the app DB, then archives the attachments volume, and
writes the two as a pair under one timestamp — `app-<ts>.dump` and `attachments-<ts>.tar.gz` — to the
host-mounted `./backups` directory, then prunes old ones.

It is listed in the `prod` and `backup` profiles, and Compose starts a service when **any** of its
profiles is active — so the `--profile prod` bring-up that `infra/start.sh` and `infra/update.sh` run
**already starts it**. To bring it up on its own (the rest of the stack already up):

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --env-file infra/env/.env.prod \
  --profile prod --profile backup up -d backup
```

> [!note] "Opt-in" in older notes
> Older notes, and the yes/no in `infra/start.sh`, describe the sidecar as opt-in and off by default.
> With the `prod` profile in its list it is not: answering *no* does not keep it down. Check with
> `$DC ps backup`.

The sidecar mounts the attachments volume **read-only**: it can archive blobs, never change them. A
restore writes through its own explicit mount ([[#Restore the attachments]]).

Tune via `.env.prod` (all optional — sane defaults shown):

```sh
BACKUP_CRON="30 2 * * *"     # when to run (crontab syntax). Default: daily 02:30.
BACKUP_RETENTION_DAYS=14     # prune DB dumps older than this many days. Default: 14.
BACKUP_ATTACHMENTS=true      # archive the attachments volume each run; false (0/no/off) skips it. Default: true.
BACKUP_ATTACHMENTS_RETENTION_DAYS=7   # prune attachments tarballs older than this many days. Default: 7.
BACKUP_MIN_FREE_MB=1024      # the attachments tarball must leave this much free on the ./backups disk,
                             # or the run refuses it before writing (loud). Default: 1024.
# OPTIONAL offsite copy — OFF unless set. Runs once per file of a run (the dump, then the tarball)
# with that file's path as "$1".
# Example (rclone to a remote named "offsite"): BACKUP_OFFSITE_CMD='rclone copy "$1" offsite:lazyit/'
BACKUP_OFFSITE_CMD=
# OPTIONAL failure alert hook — OFF unless set. Runs when the dump, the attachments tarball or the
# offsite copy fails, with a one-line reason as "$1". Lets you wire your own notifier; there is no
# built-in vendor integration. A failed run is loud in the logs and exits non-zero even without this.
# Example: BACKUP_ON_FAILURE_CMD='curl -fsS -d "$1" https://hooks.example/lazyit-backup'
BACKUP_ON_FAILURE_CMD=
```

None of these needs a line in `.env.prod`: an install updated in place gets the defaults above —
attachments on, tarballs kept 7 days, dumps kept 14 days as before.

**It does NOT back up `.env.prod`** — copy that off-host yourself. Offsite is OFF by default
(respects the "no mandatory cloud" stance, [[0028-secrets-and-config]]); wire `BACKUP_OFFSITE_CMD`
only if you want it. The sidecar does not encrypt anything — dumps and tarballs are plain files, like
the volumes they come from; encrypt the off-host copy in transit and at rest (an `rclone crypt` remote,
an encrypted bucket, an encrypted disk).

> [!info] Hook commands: name `"$1"`, or let it be appended
> A hook that names `"$1"` (or `"${1}"`) runs exactly as written, with the file path (or the failure
> reason) as `$1` — the examples above. A hook that does not mention `$1` gets it appended as its last
> argument (`BACKUP_OFFSITE_CMD=/usr/local/bin/ship-backup`). Before #1467 the argument was always
> appended, so the documented `rclone copy "$1" offsite:lazyit/` actually ran as
> `rclone copy FILE offsite:lazyit/ FILE` and failed; hooks written for the append form behave as before.

### Disk space and run time

The tarball is a **full copy every run**, and it is about the size of the volume (the blobs are mostly
PDFs, images and Office files, which are already compressed). That is why it has its own retention:
with the daily default and `BACKUP_ATTACHMENTS_RETENTION_DAYS=7`, `./backups` holds about **8
tarballs** — 8 × the volume (a tarball is pruned once it is more than 7 full days old):

| Attachments on the volume | Tarballs kept (7 days, daily — the default) | At 14 days, for comparison |
| --- | --- | --- |
| 300 MB | ~2.4 GB | ~4.5 GB |
| 1 GB | ~8 GB | ~15 GB |
| 5 GB (the default `ATTACHMENTS_MAX_TOTAL_MB` budget, full) | ~40 GB | ~75 GB |

…plus the DB dumps, as before. See where you stand:

```sh
$DC exec -T api du -sh /app/attachments     # size of the volume ≈ size of one tarball
df -h backups/                              # free space where the tarballs land
du -ch backups/attachments-*.tar.gz | tail -1
```

- **The guard.** Before writing, each run compares the volume's size with the free space on the
  `./backups` filesystem and refuses the tarball if less than `BACKUP_MIN_FREE_MB` would be left —
  `./backups` usually sits on the disk Postgres uses, and filling it would take the database down. The
  refusal is a `FAILED` run like any other (below); the DB dump of that run is kept.
- **Need less?** Lower `BACKUP_ATTACHMENTS_RETENTION_DAYS` (the dumps keep their own
  `BACKUP_RETENTION_DAYS`), give `./backups` a bigger disk (mount one there), or ship each run off-host
  with `BACKUP_OFFSITE_CMD` and keep a shorter local window. If you back the volume up some other way,
  `BACKUP_ATTACHMENTS=false` stops the tarballs; the ones already there still age out after
  `BACKUP_ATTACHMENTS_RETENTION_DAYS`.
- **Run time.** Measured under the sidecar's limits (0.5 CPU, 256 MB): about 26 s to write and 14 s to
  verify 400 MB, so roughly **10 minutes for a full 5 GB volume**. Memory stays flat — tar and gzip
  stream. The DB dump is taken first, so the run time only widens the dump-to-tarball window item #7
  describes.

### How the sidecar fails (it fails LOUD, never silent)

Each file is written to a `*.partial` temp file, verified, and only then **atomically renamed** onto
its final name. The dump must be non-empty and pass `pg_restore -l` (which reads the `-Fc` archive's
table of contents — this fails on a truncated archive); the tarball must pass `gzip -t` (the CRC of the
whole stream — it fails on truncation or corruption) and `tar -t` (every header). So:

- **A failing `pg_dump` (DB down, disk full, OOM, network blip) never leaves a file matching the
  final glob.** The half-written `*.partial` is removed; your **last good dump stays untouched**.
  (Before this fix a plain `> final.dump` redirect truncated the final path *before* pg_dump ran,
  leaving a 0-byte/corrupt file that the retention sweep treated as a real backup — issue #588.) A
  failed dump aborts the run: no tarball is taken without its dump.
- **A failing tarball** (not enough free space, a tar error after one retry, or an archive that does
  not verify) leaves no `*.partial` and keeps the **last good tarball**. It does not cost you the
  dump: that run's dump is kept, pruned and copied offsite as usual, and the run then fails.
- **Retention prunes a kind only after it succeeded** (or was deliberately skipped with
  `BACKUP_ATTACHMENTS=false`). A run whose tarball failed does not prune old tarballs, so a string of
  failures never leaves you with none. A `BACKUP_ATTACHMENTS` that is not true/false, or a
  non-numeric `BACKUP_ATTACHMENTS_RETENTION_DAYS`, fails the run loud (the dump is still written). Only `app-*.dump` and
  `attachments-*.tar.gz` are ever pruned — `update.sh`'s `pre-update-*` dumps and anything else you keep
  in `./backups` are left alone.
- **A failed run logs a distinct, greppable line** — `[lazyit-backup] FAILED run <ts>: <reason>`
  on **stderr** — and the sidecar process **exits non-zero**, so it surfaces in `docker logs` and
  to any container/cron monitoring you run. If `BACKUP_ON_FAILURE_CMD` is set, it also fires your
  alert hook with the reason as `$1`.
- The **offsite copy** runs only on files that already verified and promoted; an offsite failure
  is loud + non-zero too (the local copies are intact; the offsite copy did not happen).

Check it ran (and catch failures):

```sh
$DC logs backup | grep '\[lazyit-backup\]'           # success ends with "run ... complete"
$DC logs backup | grep 'FAILED'                       # any failed run shows here — investigate
ls -lh backups/                                        # only verified files appear here, in pairs
```

> [!warning] Present is not the same as restorable — verify, don't just `ls`
> The sidecar guarantees a *present* dump passed `pg_restore -l` and a *present* tarball passed
> `gzip -t` + `tar -t`, but a tested restore (below) is still the only proof your DR actually works.
> Periodically confirm the latest pair — at minimum re-run the same integrity checks the sidecar uses:
> ```sh
> pg_restore -l "backups/$(ls -t backups/ | grep '^app-' | head -1)" >/dev/null \
>   && echo "latest app dump: restorable" || echo "latest app dump: CORRUPT"
> gzip -t "backups/$(ls -t backups/ | grep '^attachments-.*\.tar\.gz$' | head -1)" \
>   && echo "latest attachments tarball: readable" || echo "latest attachments tarball: CORRUPT"
> ```
> and run a full **Restore + Verify** (next sections) against throwaway volumes on a schedule.
> `infra/test/backup-attachments-roundtrip.sh` does exactly that against the real sidecar, in an
> isolated compose project that never touches your stack (CI runs it on every change).

## Restore

> [!warning] Destructive
> Restoring overwrites current data. Take a fresh backup first, and prefer restoring into a clean
> database. Never test a restore against a database you can't afford to lose.

### Restore order (full DR — host rebuilt from scratch)

1. **`.env.prod` first** — put your backed-up `infra/env/.env.prod` back (it must contain the
   **same `WORKFLOW_SECRET_KEY`** as when the app DB was dumped — or the engine's stored connector
   credentials are undecryptable). `chmod 600 infra/env/.env.prod`.
2. **App DB** — restore `app-<ts>.dump` (subsection below). Bring up **only `db`**.
3. **Attachments** — restore `attachments-<ts>.tar.gz` **from the same `<ts>`**, with the api still
   down ([[#Restore the attachments]]). Never start the api between steps 2 and 3 against a database
   that does not match the volume: the attachments GC deletes blobs that no row references once they
   are older than 24 h, and restored blobs keep their original dates.
4. **Bring the stack up** — `$DC --env-file infra/env/.env.prod up -d`.
5. **Reindex Meilisearch** — `$DC --env-file infra/env/.env.prod run --rm migrate bun run reindex:all`
   (the index is rebuildable; see [[deploy-self-hosted]] §2a).
6. **BYOI only** — confirm your IdP is reachable at the same issuer with the same users (item #3).

### Restore the app DB

```sh
# Into the EXISTING database (drops & recreates objects from the dump). Stop the api first so it
# neither writes nor sweeps attachments mid-restore:
$DC --env-file infra/env/.env.prod stop api
cat app-20260530-120000.dump | $PG sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists'

# Cleanest: reset ONLY the app DB volume, then restore into a fresh db.
$DC down                                                        # stop the stack (keeps volumes)
docker volume rm lazyit-prod_db_data                            # remove ONLY the app DB volume
$DC --env-file infra/env/.env.prod up -d --wait db             # fresh, empty app db (auto-created)
cat app-20260530-120000.dump | $PG sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner'
```

Then restore the attachments from the same run (next subsection) **before** bringing up the rest:
`$DC --env-file infra/env/.env.prod up -d` (migrate is a no-op if the dump already matches the schema).

### Restore the attachments

The tarball has to be in `./backups` (copy it back there from your off-host copy). With the api
stopped, this empties the attachments volume and unpacks the tarball into it, keeping each blob's
owner (uid 1000, the api's `node` user), permissions and dates:

```sh
$DC --env-file infra/env/.env.prod stop api
$DC --env-file infra/env/.env.prod run --rm --no-deps -T -v lazyit-prod_attachments_data:/restore backup \
  sh -c 'find /restore -mindepth 1 -delete && tar -xzf /backups/attachments-20260530-120000.tar.gz -C /restore --numeric-owner'
```

It mounts the volume a second time, writable, at `/restore` — the sidecar's own `/attachments` mount
stays read-only. On a rebuilt host the command creates the volume. Then bring the stack up.

> [!danger] NEVER use `down -v` to reset just the app DB
> `down -v` removes **ALL** named volumes in the project — `meili_data_v1_53_2`, `valkey_data`,
> `attachments_data` (every uploaded file — recoverable only from a tarball, item #7), `caddy_data` and
> `caddy_config`. Resetting the app DB with `down -v` turns a routine restore into a compound outage.
> Use the targeted `docker volume rm lazyit-prod_db_data` shown above (the `lazyit-prod_` prefix is
> the compose project `name:`).

## Verify a restore

```sh
# App DB: row count.
$PG psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from users;"

# Attachments: every live attachment row has its blob (expect "0 missing blob(s)").
$PG sh -c 'psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select distinct sha256 from attachments where \"deletedAt\" is null"' \
  | $DC exec -T api sh -c 'n=0; while read -r s; do [ -f "/app/attachments/$(echo "$s" | cut -c1-2)/$s" ] || { echo "missing: $s"; n=$((n+1)); }; done; echo "$n missing blob(s)"'

# End to end: sign in via the web UI (the real proof the dump and .env.prod line up), and open a
# document on an asset or a purchase.
```

## What's NOT covered here

- **Point-in-time recovery (PITR / WAL archiving)** — out of scope for a single-host, small-team
  deployment; revisit only if the recovery objective demands it.
- **Upgrade/rollback of the bundled components** — see [[deploy-self-hosted]] (forward-only Prisma
  migrations mean rollback = restore the pre-upgrade dump + redeploy the previous image).
- **Incremental or deduplicated attachment backups** — every tarball is a full copy (see
  [[#Disk space and run time]]). Blobs are immutable and content-addressed, so an rsync/hard-link
  scheme would store each file once; it is not built.
- **Encryption of dumps and tarballs** — the sidecar writes plain files; encrypt the off-host copy.

Related: [[deploy-self-hosted]] · [[docker-prod-like-first-boot]] · [[prisma-migrations]] ·
[[auth-bootstrap]] · [[migrate-off-bundled-zitadel]] · [[0028-secrets-and-config]] · [[0015-deployment-model]] · [[0102-remove-bundled-zitadel]] · [[0061-secret-manager-zero-knowledge]] · [[0031-logging-strategy]] · [[0082-attachments-storage]]

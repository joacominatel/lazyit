#!/bin/sh
# =============================================================================
# update-tag-trust.sh — the release-tag trust rule of infra/update.sh (ADR-0083 §Tag trust, ADR-0084 §3
# step 4, issue #1458). Proves, against real git repositories, that the updater:
#   - ACCEPTS an unsigned annotated vX.Y.Z tag on origin/master (what release.yml cuts),
#   - fetches master + the tag in the same run (a tag pushed after the clone is accepted; a locally moved
#     origin/master does not count),
#   - REFUSES a lightweight tag, a tag whose commit is not on origin/master, a non-vX.Y.Z name, a tag that
#     only exists locally, a local tag that differs from origin's, and a re-labelled tag object,
#   - REFUSES an insecure origin (http://, git://, HTTPS with certificate checks off, an insteadOf rewrite
#     to http://) before fetching anything,
#   - checks a signature when there is one: SSH-signed with no allowed-signers file → accepted when the
#     signature is valid, REFUSED when it is bad; with an allowed-signers file → it must verify. OpenPGP:
#     unknown key → accepted with a warning; a bad signature → REFUSED.
#   - rejects an invalid tag argument before touching anything.
#
# Fully OFFLINE: a bare repo on disk stands in for GitHub, and update.sh is sourced through its test seam
# (LAZYIT_UPDATE_LIB_ONLY=1 — NEVER set in a real deploy) so only the trust functions run: no Docker, no
# database, no checkout of this repository is touched. The SSH and OpenPGP cases need ssh-keygen / gpg
# (both preinstalled on the ubuntu-latest runner) and are skipped, loudly, when missing.
#
# Run from anywhere:  sh infra/test/update-tag-trust.sh      (VERBOSE=1 also prints each case's output)
# =============================================================================
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SELF_DIR/../.." && pwd)
UPDATE_SH="$REPO_ROOT/infra/update.sh"

WORK=$(mktemp -d)
cleanup() {
  for _h in "$WORK"/gnupg-*; do
    [ -d "$_h" ] && gpgconf --homedir "$_h" --kill all >/dev/null 2>&1 || true
  done
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Isolate git from the host: no system/global config (signing programs, insteadOf, sslVerify, …).
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$WORK/gitconfig"
export HOME="$WORK/home"
unset GIT_SSL_NO_VERIFY GNUPGHOME 2>/dev/null || true
mkdir -p "$HOME"
cat >"$GIT_CONFIG_GLOBAL" <<'EOF'
[user]
	name = Release Test
	email = release-test@example.invalid
[init]
	defaultBranch = master
[advice]
	detachedHead = false
[commit]
	gpgsign = false
[tag]
	gpgSign = false
EOF

fail=0
pass=0
flunk() { echo "FAIL: $*"; fail=1; }

ORIGIN="$WORK/origin.git"   # stands in for github.com/joacominatel/lazyit
MAINT="$WORK/maint"         # the release side: commits + tags, pushed to origin
OP="$WORK/op"               # the operator's install (a clone of origin)

git init -q --bare "$ORIGIN"
git init -q "$MAINT"
git -C "$MAINT" remote add origin "$ORIGIN"
commit() { # commit <repo> <message>
  printf '%s\n' "$2" >>"$1/log.txt"
  git -C "$1" add log.txt
  git -C "$1" commit -q -m "$2"
}
commit "$MAINT" "first"
commit "$MAINT" "second"
git -C "$MAINT" push -q origin master
git clone -q "$ORIGIN" "$OP"

# trust <tag> [extra env assignments…] — run update.sh's verify_release_tag in the operator clone.
# Prints "ACCEPT <commit>" or "REFUSE: <reason>" followed by the function's own output.
trust() {
  _t=$1; shift
  (
    cd "$OP"
    # shellcheck disable=SC2016  # expanded by the inner sh, on purpose
    env "$@" LAZYIT_UPDATE_LIB_ONLY=1 sh -c '
      . "$1"
      if verify_release_tag "$2"; then echo "ACCEPT $TAG_TRUST_COMMIT"; else echo "REFUSE: $TAG_TRUST_ERROR"; fi
    ' trust "$UPDATE_SH" "$_t" 2>&1
  ) || true
}

# expect <accept|refuse> <description> <output> [grep -E pattern the output must contain]
expect() {
  _want=$1; _desc=$2; _out=$3; _pat=${4:-}
  case "$_want" in
    accept) printf '%s\n' "$_out" | grep -q '^ACCEPT ' || { flunk "$_desc — expected ACCEPT, got:"; printf '%s\n' "$_out" | sed 's/^/    /'; return 0; } ;;
    refuse) printf '%s\n' "$_out" | grep -q '^REFUSE: ' || { flunk "$_desc — expected REFUSE, got:"; printf '%s\n' "$_out" | sed 's/^/    /'; return 0; } ;;
  esac
  if [ -n "$_pat" ] && ! printf '%s\n' "$_out" | grep -Eq -- "$_pat"; then
    flunk "$_desc — output lacks /$_pat/:"; printf '%s\n' "$_out" | sed 's/^/    /'; return 0
  fi
  pass=$((pass + 1))
  echo "ok   - $_desc"
  [ -z "${VERBOSE:-}" ] || printf '%s\n' "$_out" | sed 's/^/    /'
}

# ---------------------------------------------------------------------------
# 1. An unsigned annotated tag on master — exactly what release.yml cuts — is accepted, and the commit
#    handed to the checkout is the tagged one.
# ---------------------------------------------------------------------------
git -C "$MAINT" tag -a v1.1.0 -m "lazyit v1.1.0"
git -C "$MAINT" push -q origin v1.1.0
out=$(trust v1.1.0)
expect accept "unsigned annotated tag on master" "$out" "unsigned"
[ "$(printf '%s\n' "$out" | sed -n 's/^ACCEPT //p')" = "$(git -C "$MAINT" rev-parse 'v1.1.0^{commit}')" ] \
  || flunk "the accepted commit is not the one v1.1.0 points at"

# 2. Freshness: master moved and a new tag was pushed AFTER the operator cloned — the in-run fetch sees it.
commit "$MAINT" "third"
git -C "$MAINT" push -q origin master
git -C "$MAINT" tag -a v1.2.0 -m "lazyit v1.2.0"
git -C "$MAINT" push -q origin v1.2.0
expect accept "tag on a master commit newer than the clone" "$(trust v1.2.0)"

# 3. A lightweight tag on master is refused.
git -C "$MAINT" tag v1.3.0
git -C "$MAINT" push -q origin v1.3.0
expect refuse "lightweight tag" "$(trust v1.3.0)" "lightweight"

# 4. An annotated tag on a commit that is NOT on master is refused.
git -C "$MAINT" checkout -q -b feature
commit "$MAINT" "feature work"
git -C "$MAINT" tag -a v1.4.0 -m "lazyit v1.4.0"
git -C "$MAINT" push -q origin feature v1.4.0
git -C "$MAINT" checkout -q master
expect refuse "annotated tag off master" "$(trust v1.4.0)" "not on origin/master"

# 5. A locally moved origin/master does not count: the run re-fetches it from origin.
git -C "$OP" fetch -q origin feature
git -C "$OP" update-ref refs/remotes/origin/master "$(git -C "$MAINT" rev-parse feature)"
expect refuse "tag off master with a forged local origin/master" "$(trust v1.4.0)" "not on origin/master"
[ "$(git -C "$OP" rev-parse refs/remotes/origin/master)" = "$(git -C "$MAINT" rev-parse master)" ] \
  || flunk "origin/master was not refreshed from origin"

# 6. Names that are not vX.Y.Z are refused, even when annotated and on master.
git -C "$MAINT" tag -a release-1.5.0 -m "not a release name"
git -C "$MAINT" push -q origin release-1.5.0
expect refuse "non-v tag name" "$(trust release-1.5.0)" "not a release tag"
expect refuse "two-component tag name" "$(trust v1.5)" "not a release tag"
expect refuse "pre-release suffix" "$(trust v1.5.0-rc.1)" "not a release tag"

# 7. A tag that exists only in the operator's clone (never published) is refused.
git -C "$OP" tag -a v1.6.0 -m "local only" origin/master
expect refuse "tag missing on origin" "$(trust v1.6.0)" "could not fetch tag v1.6.0"

# 8. A local tag that differs from origin's is refused, never overwritten.
git -C "$OP" tag -d v1.1.0 >/dev/null 2>&1 || true
git -C "$OP" tag -a v1.1.0 -m "a different object" "$(git -C "$MAINT" rev-parse 'v1.1.0^{commit}')"
_local=$(git -C "$OP" rev-parse v1.1.0)
expect refuse "local tag differs from origin's" "$(trust v1.1.0)" "differs from origin"
[ "$(git -C "$OP" rev-parse v1.1.0)" = "$_local" ] || flunk "the operator's local tag was overwritten"
git -C "$OP" tag -d v1.1.0 >/dev/null

# 9. A tag object re-labelled under another name (made as v1.7.0, published as v1.8.0) is refused.
git -C "$MAINT" tag -a v1.7.0 -m "lazyit v1.7.0"
git -C "$MAINT" update-ref refs/tags/v1.8.0 "$(git -C "$MAINT" rev-parse v1.7.0)"
git -C "$MAINT" tag -d v1.7.0 >/dev/null
git -C "$MAINT" push -q origin refs/tags/v1.8.0
expect refuse "re-labelled tag object" "$(trust v1.8.0)" "names itself 'v1.7.0'"

# ---------------------------------------------------------------------------
# 10. Transport. Each insecure origin is refused before any fetch (the URLs point nowhere reachable).
# ---------------------------------------------------------------------------
set_origin() { git -C "$OP" remote set-url origin "$1"; }
set_origin "http://127.0.0.1:9/lazyit.git"
expect refuse "http:// origin" "$(trust v1.1.0)" "unauthenticated transport"
set_origin "HTTP://127.0.0.1:9/lazyit.git"
expect refuse "HTTP:// origin (any case)" "$(trust v1.1.0)" "unauthenticated transport"
set_origin "git://127.0.0.1:9/lazyit.git"
expect refuse "git:// origin" "$(trust v1.1.0)" "unauthenticated transport"
set_origin "https://user:s3cret@127.0.0.1:9/lazyit.git"
out=$(trust v1.1.0 GIT_SSL_NO_VERIFY=1)
expect refuse "https:// origin with GIT_SSL_NO_VERIFY" "$out" "unauthenticated transport"
printf '%s\n' "$out" | grep -q 's3cret' && flunk "a credential embedded in the origin URL was printed"
git -C "$OP" config http.sslVerify false
expect refuse "https:// origin with http.sslVerify=false" "$(trust v1.1.0)" "unauthenticated transport"
git -C "$OP" config --unset http.sslVerify
git -C "$OP" config url."http://127.0.0.1:9/".insteadOf "gh:"
set_origin "gh:lazyit.git"
expect refuse "insteadOf rewrite to http://" "$(trust v1.1.0)" "unauthenticated transport"
git -C "$OP" config --remove-section url."http://127.0.0.1:9/"
git -C "$OP" remote remove origin
expect refuse "no origin remote" "$(trust v1.1.0)" "no 'origin' remote"
git -C "$OP" remote add origin "$ORIGIN"
expect accept "local-path origin restored" "$(trust v1.1.0)"

# The URL classifier itself: HTTPS and SSH (all spellings) and local paths are authenticated transports.
for u in https://github.com/joacominatel/lazyit.git ssh://git@github.com/joacominatel/lazyit.git \
         git@github.com:joacominatel/lazyit.git file:///srv/lazyit.git /srv/lazyit.git; do
  if (cd "$OP" && LAZYIT_UPDATE_LIB_ONLY=1 sh -c '. "$1"; is_secure_fetch_url "$2"' u "$UPDATE_SH" "$u"); then
    pass=$((pass + 1)); echo "ok   - transport accepted: $u"
  else
    flunk "transport wrongly refused: $u"
  fi
done
for u in http://github.com/x.git git://github.com/x.git ftp://h/x.git 'ext::sh -c evil'; do
  if (cd "$OP" && LAZYIT_UPDATE_LIB_ONLY=1 sh -c '. "$1"; is_secure_fetch_url "$2"' u "$UPDATE_SH" "$u"); then
    flunk "transport wrongly accepted: $u"
  else
    pass=$((pass + 1)); echo "ok   - transport refused: $u"
  fi
done

# ---------------------------------------------------------------------------
# 11. SSH-signed tags (the hand-seeded v1.0.0 style).
# ---------------------------------------------------------------------------
# forge_tag <repo> <tag> — rewrite <tag>'s object with an altered message, keeping its signature, and
# point the ref at the forgery (a signature that no longer matches its content).
forge_tag() {
  _obj=$(git -C "$1" cat-file tag "$2" | sed "s/^lazyit $2\$/lazyit $2 (altered after signing)/" \
    | git -C "$1" hash-object -t tag -w --stdin)
  git -C "$1" update-ref "refs/tags/$2" "$_obj"
}

if command -v ssh-keygen >/dev/null 2>&1; then
  ssh-keygen -q -t ed25519 -N '' -C release -f "$WORK/release_key"
  ssh-keygen -q -t ed25519 -N '' -C other -f "$WORK/other_key"
  sign_ssh() { git -C "$MAINT" -c gpg.format=ssh -c user.signingkey="$WORK/release_key" tag -s "$1" -m "lazyit $1"; }
  sign_ssh v2.0.0
  sign_ssh v2.1.0
  forge_tag "$MAINT" v2.1.0
  git -C "$MAINT" push -q origin v2.0.0 v2.1.0

  expect accept "SSH-signed, no allowed-signers file, valid signature" "$(trust v2.0.0)" "signature is valid"
  expect refuse "SSH-signed, no allowed-signers file, BAD signature" "$(trust v2.1.0)" "BAD SSH signature"

  printf 'release-test@example.invalid %s\n' "$(cut -d' ' -f1,2 "$WORK/release_key.pub")" >"$WORK/allowed_ok"
  printf 'release-test@example.invalid %s\n' "$(cut -d' ' -f1,2 "$WORK/other_key.pub")" >"$WORK/allowed_other"
  git -C "$OP" config gpg.ssh.allowedSignersFile "$WORK/allowed_ok"
  expect accept "SSH-signed, signer in allowed signers" "$(trust v2.0.0)" "verified against your allowed signers"
  expect refuse "SSH-signed, allowed signers, BAD signature" "$(trust v2.1.0)" "does NOT verify"
  git -C "$OP" config gpg.ssh.allowedSignersFile "$WORK/allowed_other"
  expect refuse "SSH-signed by a signer not in allowed signers" "$(trust v2.0.0)" "does NOT verify"
  git -C "$OP" config gpg.ssh.allowedSignersFile "$WORK/does-not-exist"
  expect accept "allowed-signers file configured but missing" "$(trust v2.0.0)" "does not exist"
  git -C "$OP" config --unset gpg.ssh.allowedSignersFile
else
  echo "SKIP - SSH signature cases: ssh-keygen not installed"
fi

# ---------------------------------------------------------------------------
# 12. OpenPGP-signed tags.
# ---------------------------------------------------------------------------
if command -v gpg >/dev/null 2>&1; then
  GM="$WORK/gnupg-maint"; GO="$WORK/gnupg-op"
  mkdir -m 700 "$GM" "$GO"
  GNUPGHOME="$GM" gpg --batch --quiet --passphrase '' --quick-gen-key 'Release Test <release-test@example.invalid>' ed25519 sign never 2>/dev/null
  fpr=$(GNUPGHOME="$GM" gpg --batch --with-colons --list-secret-keys 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}')
  sign_pgp() { GNUPGHOME="$GM" git -C "$MAINT" -c gpg.format=openpgp -c user.signingkey="$fpr" tag -s "$1" -m "lazyit $1"; }
  sign_pgp v3.0.0
  sign_pgp v3.1.0
  forge_tag "$MAINT" v3.1.0
  git -C "$MAINT" push -q origin v3.0.0 v3.1.0

  expect accept "OpenPGP-signed, signer's key not in the keyring" "$(trust v3.0.0 GNUPGHOME="$GO")" "public key is not in your keyring"
  GNUPGHOME="$GM" gpg --batch --export "$fpr" | GNUPGHOME="$GO" gpg --batch --quiet --import 2>/dev/null
  expect accept "OpenPGP-signed, key imported, good signature" "$(trust v3.0.0 GNUPGHOME="$GO")" "OpenPGP signature verified"
  expect refuse "OpenPGP-signed, key imported, BAD signature" "$(trust v3.1.0 GNUPGHOME="$GO")" "FAILED verification"
else
  echo "SKIP - OpenPGP signature cases: gpg not installed"
fi

# ---------------------------------------------------------------------------
# 13. The CLI rejects an invalid tag argument before it does anything (no lock, no backup, no Docker).
# ---------------------------------------------------------------------------
for bad in v1.5 'v1.5.0;id' v1.5.0-rc.1 1.5.0; do
  if _o=$(sh "$UPDATE_SH" --yes "$bad" 2>&1); then
    flunk "update.sh accepted the tag argument '$bad'"
  elif printf '%s\n' "$_o" | grep -q "invalid target tag"; then
    pass=$((pass + 1)); echo "ok   - CLI rejects '$bad'"
  else
    flunk "update.sh failed on '$bad' for another reason:"; printf '%s\n' "$_o" | sed 's/^/    /'
  fi
done

echo
if [ "$fail" -ne 0 ]; then
  echo "update-tag-trust: FAILED ($pass passed)"
  exit 1
fi
echo "update-tag-trust: all $pass checks passed"

#!/bin/sh
# Headless "browser" for the W4-3 matrix runs (docs/05-runbooks/ai-mcp-client-matrix.md).
# A client that opens the authorization URL through $BROWSER (the MCP Inspector does) gets it
# approved on the consent API by consent.mjs, and the redirect is then followed to the client's
# loopback callback. Needs BASE and SESSION (see consent.mjs). Logs to $FAKE_BROWSER_LOG or stderr.
LOG="${FAKE_BROWSER_LOG:-/dev/stderr}"
HERE=$(dirname "$0")
REDIRECT=$(node "$HERE/consent.mjs" "$1" 2>>"$LOG") || exit 1
curl -sS -o /dev/null -w "callback %{http_code}\n" "$REDIRECT" >>"$LOG" 2>&1

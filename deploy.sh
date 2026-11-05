#!/usr/bin/env bash
# Deploys Reforge (the src folder) to Netlify production and prints the live URL.
# Usage: ./deploy.sh
set -euo pipefail

SITE_ID="72367b1c-0768-4b59-813f-358d2cd23f0c"   # Netlify project: reforge-study
cd "$(dirname "$0")"

# npx lives here on this Mac; add it to PATH if the shell doesn't know it
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx not found. Install Node.js from https://nodejs.org and try again." >&2
  exit 1
fi

MESSAGE="$(git log -1 --pretty=%s 2>/dev/null || echo "Manual deploy")"
echo "Deploying src/ to Netlify…"
OUTPUT="$(npx --yes netlify-cli deploy --prod --dir=src --site="$SITE_ID" --message="$MESSAGE" --json)"

URL="$(printf '%s' "$OUTPUT" | python3 -c 'import sys, json; d = json.load(sys.stdin); print(d.get("url") or d.get("deploy_url"))')"
echo "Live: $URL"

#!/usr/bin/env bash
set -euo pipefail

# Seeds a small dataset via the web bridge for demo purposes
# Usage: ./scripts/seed_data.sh [base_url]

BASE_URL=${1:-http://127.0.0.1:3000}

curl -sS -X POST "$BASE_URL/api/todos" -H 'content-type: application/json' -d '{"title":"Buy milk","priority":"high","scheduledFor":null}' >/dev/null
curl -sS -X POST "$BASE_URL/api/todos" -H 'content-type: application/json' -d '{"title":"Morning run","priority":"high","scheduledFor":"'"$(date +%Y-%m-%d)'"'"}"' >/dev/null
curl -sS -X POST "$BASE_URL/api/todos" -H 'content-type: application/json' -d '{"title":"Review emails","priority":"low","scheduledFor":"'"$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d yesterday +%Y-%m-%d)'"'"}"' >/dev/null
echo "Seeded sample todos to $BASE_URL"



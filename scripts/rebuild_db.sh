#!/usr/bin/env bash
set -euo pipefail

# Rebuild the SQLite database and seed sample data.
# Uses apps/server/database/migration_script.js which wipes and seeds todos, events, habits.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."

cd "${REPO_ROOT}"

# Allow override, otherwise default to repo data/app.db
export APP_DB_PATH="${APP_DB_PATH:-${REPO_ROOT}/data/app.db}"

echo "[rebuild_db] Rebuilding DB at: ${APP_DB_PATH}"
node apps/server/database/migration_script.js
echo "[rebuild_db] Done."



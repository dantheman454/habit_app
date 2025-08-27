#!/usr/bin/env bash
set -euo pipefail

# Rebuild the SQLite database and seed sample data.
# Uses scripts/seed_tasks_and_events.js which wipes and seeds todos and events.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."

cd "${REPO_ROOT}"

# Allow override, otherwise default to repo data/app.db
export APP_DB_PATH="/Users/dantheman/Desktop/habit_app/data/app.db"

echo "[rebuild_db] Rebuilding DB at: ${APP_DB_PATH}"
node scripts/seed_tasks_and_events.js
echo "[rebuild_db] Done."



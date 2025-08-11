#!/usr/bin/env bash
set -euo pipefail

# Clears persisted todo data files under data/

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
DATA_DIR="$ROOT_DIR/data"

rm -f "$DATA_DIR/todos.json" "$DATA_DIR/counter.json"
echo "Cleared $DATA_DIR (todos.json, counter.json)"



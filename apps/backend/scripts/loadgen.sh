#!/usr/bin/env bash
# Continuous mixed-traffic load generator for the observability dashboards.
#
#   scripts/loadgen.sh [interval_ms]        # interval between requests (default 250)
#   LOADGEN_URL=http://host:port scripts/loadgen.sh
#
# Endpoints mix: latency profile / random errors / slow / db / multi-hop / cpu

set -euo pipefail

INTERVAL_MS="${1:-250}"
BASE="${LOADGEN_URL:-http://localhost:8000/api/v1/test}"
INTERVAL_S="$(awk "BEGIN { print $INTERVAL_MS / 1000 }")"

echo "loadgen -> $BASE every ${INTERVAL_MS}ms (ctrl-c to stop)"

while true; do
  roll=$((RANDOM % 100))
  if ((roll < 60)); then
    curl -s -m 15 -o /dev/null "$BASE/latency" &
  elif ((roll < 80)); then
    curl -s -m 15 -o /dev/null "$BASE/slow?ms=$((RANDOM % 700))" &
  elif ((roll < 93)); then
    curl -s -m 15 -o /dev/null "$BASE/random-error?rate=0.15" &
  elif ((roll < 97)); then
    curl -s -m 15 -o /dev/null "$BASE/multi-hop?depth=2&workMs=5" &
  else
    curl -s -m 15 -o /dev/null "$BASE/db?ms=$((RANDOM % 200))" &
  fi

  sleep "$INTERVAL_S"
done

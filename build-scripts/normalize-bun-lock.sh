#!/usr/bin/env bash
set -euo pipefail

lockfile="${1:-bun.lock}"
normalized_lockfile=$(mktemp "${lockfile}.XXXXXX")
trap 'rm -f "$normalized_lockfile"' EXIT

sed -E 's#"https://(repox\.jfrog\.io|repox-internal(\.dev)?\.sonar\.build)/artifactory/api/npm/npm/[^" ]+"#""#g' "$lockfile" > "$normalized_lockfile"
cat "$normalized_lockfile" > "$lockfile"

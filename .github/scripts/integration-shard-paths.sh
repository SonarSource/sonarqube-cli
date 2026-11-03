#!/usr/bin/env bash
# Print integration test directory paths for CI shard INDEX out of TOTAL.
# Top-level folders under tests/integration/specs/ are assigned by cksum(name) % TOTAL.
# tests/integration/harness/ is always included on shard 0 (single harness self-test).
set -euo pipefail

index="${INTEGRATION_SHARD_INDEX:?INTEGRATION_SHARD_INDEX is required}"
total="${INTEGRATION_SHARD_TOTAL:?INTEGRATION_SHARD_TOTAL is required}"

if ! [[ "$index" =~ ^[0-9]+$ && "$total" =~ ^[0-9]+$ ]]; then
  echo "INTEGRATION_SHARD_INDEX and INTEGRATION_SHARD_TOTAL must be non-negative integers" >&2
  exit 1
fi
if (( total < 1 || index >= total )); then
  echo "INTEGRATION_SHARD_INDEX must be in [0, INTEGRATION_SHARD_TOTAL)" >&2
  exit 1
fi

specs_root="tests/integration/specs"
if [ ! -d "$specs_root" ]; then
  echo "Missing ${specs_root}" >&2
  exit 1
fi

count=0
while IFS= read -r -d '' dir; do
  name=$(basename "$dir")
  bucket=$(printf '%s' "$name" | cksum | awk '{print $1}')
  if (( bucket % total == index )); then
    printf '%s\n' "${dir%/}"
    count=$((count + 1))
  fi
done < <(find "$specs_root" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)

if (( index == 0 )); then
  printf '%s\n' "tests/integration/harness"
  count=$((count + 1))
fi

if (( count == 0 )); then
  echo "Shard ${index}/${total} matched no integration directories" >&2
  exit 1
fi

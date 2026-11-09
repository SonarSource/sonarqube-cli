#!/usr/bin/env bash
# Lists nested AGENTS.md canary codewords for the loading experiment.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
shopt -s globstar nullglob
found=0
for file in src/**/AGENTS.md tests/AGENTS.md; do
  [[ -f "$file" ]] || continue
  line=$(grep -m1 'nested-agents-canary:' "$file" || true)
  if [[ -n "$line" ]]; then
    codeword=$(sed -n 's/.*nested-agents-canary: \([^ ]*\).*/\1/p' <<<"$line")
    printf '%s\t%s\n' "$file" "$codeword"
    found=$((found + 1))
  else
    printf '%s\t(no canary)\n' "$file" >&2
  fi
done
if [[ "$found" -eq 0 ]]; then
  echo "No nested canaries found under $root" >&2
  exit 1
fi

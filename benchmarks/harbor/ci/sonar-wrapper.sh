#!/bin/bash
real=$HOME/.local/share/sonarqube-cli/bin/sonar
log=/logs/sonar-calls.log
printf '%s\tSTART\t%s\t\n' "$(date -u +%FT%TZ)" "$*" >> "$log"
tmp=$(mktemp -d)
mkfifo "$tmp/err.pipe"
tee "$tmp/err.txt" < "$tmp/err.pipe" >&2 &
tee_pid=$!
"$real" "$@" 2> "$tmp/err.pipe"
code=$?
wait "$tee_pid"
printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$code" "$*" "$(head -c 300 "$tmp/err.txt" | tr '\n' ' ')" >> "$log"
rm -rf "$tmp"
exit $code

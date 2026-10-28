#!/bin/bash
real=$HOME/.local/share/sonarqube-cli/bin/sonar
log=/logs/sonar-calls.log
printf '%s\tSTART\t%s\t\n' "$(date -u +%FT%TZ)" "$*" >> "$log"
err=$(mktemp)
"$real" "$@" 2> >(tee "$err" >&2)
code=$?
wait $! 2>/dev/null
printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$code" "$*" "$(head -c 300 "$err" | tr '\n' ' ')" >> "$log"
rm -f "$err"
exit $code

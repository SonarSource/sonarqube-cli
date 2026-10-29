#!/bin/bash
set -euo pipefail
ci="$(dirname "$0")/../../../ci"
"$ci/init-app-repo.sh"
printf '{\n  "payments": {}\n}\n' > /app/config.json
"$ci/enable-claude-hooks.sh"

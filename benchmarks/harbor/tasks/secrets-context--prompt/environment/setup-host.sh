#!/bin/bash
set -euo pipefail
ci="$(dirname "$0")/../../../ci"
"$ci/init-app-repo.sh"
"$ci/install-agent-plugin.sh"
printf '{\n  "payments": {}\n}\n' > /app/config.json
"$ci/enable-hooks.sh"

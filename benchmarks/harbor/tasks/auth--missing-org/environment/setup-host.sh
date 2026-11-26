#!/bin/bash
set -euo pipefail
ci="$(dirname "$0")/../../../ci"
"$ci/init-app-repo.sh"
"$ci/install-agent-plugin.sh"

#!/usr/bin/env bash
# 1. Removes the MDM-managed binary.
# 2. Keeps removing wherever sonar resolves in system PATH until nothing is found.
# 3. Removes standalone installs from every local user's home directory.
set -euo pipefail

MDM_BINARY="/usr/local/bin/sonar"
STANDALONE_REL=".local/share/sonarqube-cli/bin/sonar"
export PATH="/usr/local/bin:$PATH"

# -- Remove MDM binary ---------------------------------------------------------

rm -f "$MDM_BINARY"

if [[ -f "$MDM_BINARY" ]]; then
    echo "Error: failed to remove $MDM_BINARY" >&2
    exit 1
fi
echo "MDM binary removed from $MDM_BINARY."

# -- Remove any remaining resolvable copies (system PATH) ----------------------
# Catches binaries in Homebrew, manually added PATH entries, etc.

while true; do
    sonar_path="$(command -v sonar 2>/dev/null || true)"
    [[ -z "$sonar_path" ]] && break
    if ! "$sonar_path" --version 2>/dev/null | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
        echo "Error: $sonar_path does not look like the SonarQube CLI (unexpected --version output) -- refusing to remove it." >&2
        exit 1
    fi
    echo "sonar still resolves to: $sonar_path -- removing..."
    rm -f "$sonar_path"
    if [[ -e "$sonar_path" ]]; then
        echo "Error: failed to remove $sonar_path" >&2
        exit 1
    fi
done

# -- Remove standalone installs from all local user home directories -----------
# These are not in SYSTEM's PATH so command -v cannot find them.

get_user_homes() {
    case "$(uname -s)" in
        Darwin)
            dscl . list /Users NFSHomeDirectory \
                | awk '$1 !~ /^_/ && $2 ~ /^\/Users\// { print $2 }'
            ;;
        Linux)
            getent passwd | awk -F: '$6 ~ /^\/home\// { print $6 }'
            ;;
    esac
}

while IFS= read -r home; do
    standalone="$home/$STANDALONE_REL"
    [[ -e "$standalone" || -L "$standalone" ]] || continue
    echo "  $standalone -- removing..."
    rm -f "$standalone"
done < <(get_user_homes)

echo "which sonar: not found"

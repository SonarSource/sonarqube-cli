#!/usr/bin/env bash
# Prototype: fire the SonarNotifier.app notification (with click-to-launch-terminal)
# into the console user's session from a root/SYSTEM context, e.g. an MDM push
# command. Expects SonarNotifier.app to already sit next to the `sonar` binary
# installed by install.sh (same $INSTALL_DIR) — the actual CLI install/update
# step is where this helper would be placed in production, since a push command
# like this one only carries its own script text, no sibling files.
set -euo pipefail

TITLE="SonarQube CLI installed"
MESSAGE="Click to run: sonar auth login"
COMMAND="sonar auth login"

CONSOLE_USER="$(stat -f '%Su' /dev/console)"
if [[ -z "$CONSOLE_USER" || "$CONSOLE_USER" == "root" || "$CONSOLE_USER" == "loginwindow" ]]; then
  echo "No console user logged in (got: '$CONSOLE_USER') — skipping notification." >&2
  exit 0
fi
CONSOLE_UID="$(id -u "$CONSOLE_USER")"
CONSOLE_HOME="$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory | awk '{print $2}')"

echo "Resolved console user: $CONSOLE_USER (uid $CONSOLE_UID, home $CONSOLE_HOME)"
echo "Firing as: $(whoami) (uid $(id -u))"

# Same $INSTALL_DIR install.sh uses for the `sonar` binary itself.
APP="$CONSOLE_HOME/.local/share/sonarqube-cli/bin/SonarNotifier.app"
BINARY="$APP/Contents/MacOS/notifier"

if [[ ! -x "$BINARY" ]]; then
  echo "SonarNotifier.app not found at $APP — expected it to be installed alongside the sonar binary." >&2
  exit 1
fi

# Re-sign (ad-hoc) and register with Launch Services on every run: cheap and
# idempotent, and required at least once per machine for UNUserNotificationCenter
# to accept a non-notarized, unpackaged .app at all.
codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

launchctl asuser "$CONSOLE_UID" sudo -u "$CONSOLE_USER" "$BINARY" "$TITLE" "$MESSAGE" "$COMMAND"

echo "Notifier launched (stays alive up to 60s waiting for a click)."

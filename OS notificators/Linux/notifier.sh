#!/usr/bin/env bash
# Native Linux desktop notification helper for SonarQube CLI.
#
# Mirrors the macOS/Windows notifiers as closely as a POSIX shell + D-Bus allows:
#
#   runInTerminal()          → open_terminal()
#   NotificationDelegate     → dbus-monitor for ActionInvoked/NotificationClosed
#   RunLoop (60 s)           → timeout 60 gdbus monitor ...
#   exit(0) on click         → exit 0 after open_terminal
#
# Linux-only addition: when invoked as root (e.g. from an MDM policy or
# provisioning script), it detects the active graphical session via loginctl
# and hands off to that user — desktop notifications are per-user-session and
# root has none, the same problem the macOS script solves with `launchctl
# asuser`. Many MDM agents (e.g. JumpCloud Commands) run the pasted script
# text via `bash -c "<contents>"` with no backing file at all, so $0 is just
# the literal string "bash", not a usable path — re-execing "$0" as the target
# user fails. Instead the two functions below are serialized with `declare -f`
# and replayed inside the target user's `bash -c` session, so the hand-off
# never depends on this script's own on-disk location.
#
# Usage: notifier.sh <title> <message> [command-to-run-in-terminal]
set -euo pipefail

TITLE="${1:-SonarQube CLI installed}"
MESSAGE="${2:-Click to run: sonar auth login}"
COMMAND="${3:-sonar auth login}"

# ── Launch a terminal running $COMMAND ───────────────────────────────────────
# Mirrors runInTerminal(_ command: String?) in notifier.swift / Invoke-InTerminal.
open_terminal() {
  local cmd="$1"
  echo "Action clicked — opening a terminal for: $cmd" >&2
  for term in x-terminal-emulator gnome-terminal konsole xfce4-terminal alacritty xterm; do
    if command -v "$term" >/dev/null 2>&1; then
      echo "Using terminal: $term" >&2
      "$term" -e bash -lc "$cmd; exec bash" &
      return 0
    fi
  done
  echo "No terminal emulator found in PATH — cannot run: $cmd" >&2
  return 1
}

# ── Fire notification + wait for click ───────────────────────────────────────
# Mirrors the UNUserNotificationCenter setup in notifier.swift.
# Two actions are offered so the click works regardless of how the server
# renders them: "default" is the reserved id GNOME/KDE invoke on a plain body
# click (no visible button); "open" is a real labeled button for servers
# (dunst, xfce4-notifyd, mate-notification-daemon, ...) that only support
# actions as explicit buttons and ignore unlabeled "default". We react to
# either — same as macOS/Windows treating the whole banner as the click target.
notify_and_wait() {
  local title="$1" message="$2" command="$3"

  if ! command -v gdbus >/dev/null 2>&1; then
    echo "gdbus not found — cannot deliver a native notification." >&2
    exit 1
  fi
  if ! command -v dbus-monitor >/dev/null 2>&1; then
    echo "dbus-monitor not found — cannot wait for a notification click." >&2
    exit 1
  fi

  local caps
  caps="$(gdbus call --session \
    --dest org.freedesktop.Notifications \
    --object-path /org/freedesktop/Notifications \
    --method org.freedesktop.Notifications.GetCapabilities 2>&1 || true)"
  echo "Notification server capabilities: $caps" >&2
  if [[ "$caps" != *"actions"* ]]; then
    echo "WARNING: server does not advertise 'actions' support — click-to-run will not work on this notification daemon." >&2
  fi

  local notif_id
  notif_id="$(gdbus call --session \
    --dest org.freedesktop.Notifications \
    --object-path /org/freedesktop/Notifications \
    --method org.freedesktop.Notifications.Notify \
    "SonarQube CLI" 0 "" "$title" "$message" "['default', '', 'open', 'Open terminal']" '{}' 60000 \
    | grep -oE '[0-9]+' | tail -n1)"

  echo "Notification $notif_id shown, waiting up to 60s for a click…"

  # `gdbus monitor --dest org.freedesktop.Notifications` resolves --dest to
  # that name's current *owner* and filters on sender == owner. On GNOME
  # Shell, ActionInvoked/NotificationClosed are actually emitted by an
  # internal proxy distinct from the bus name's registered owner, so a
  # --dest-filtered `gdbus monitor` silently never observes the click.
  # dbus-monitor's raw match rules filter on interface/path instead of a
  # pre-resolved sender, so it sees the signal regardless of which internal
  # component emits it. Its output splits each signal across multiple lines
  # (a header, then one line per argument), so track which signal we're in.
  local member=""
  timeout 60 dbus-monitor --session \
    "type='signal',interface='org.freedesktop.Notifications',path='/org/freedesktop/Notifications'" \
    | while read -r line; do
        echo "D-Bus line: $line" >&2
        if [[ "$line" == *"member=ActionInvoked"* ]]; then
          member="ActionInvoked"
        elif [[ "$line" == *"member=NotificationClosed"* ]]; then
          member="NotificationClosed"
        elif [[ "$line" == signal\ * || "$line" == "method call"\ * ]]; then
          member=""
        elif [[ -n "$member" && "$line" == *"uint32 "* ]]; then
          local id
          id="$(grep -oE '[0-9]+' <<<"$line" | tail -n1)"
          if [[ "$id" == "$notif_id" ]]; then
            if [[ "$member" == "ActionInvoked" ]]; then
              open_terminal "$command"
            fi
            break
          fi
          member=""
        fi
      done || true

  echo "Notifier finished (no click within 60s, or notification dismissed)."
}

# ── root → interactive-user hand-off ─────────────────────────────────────────
# Mirrors CONSOLE_USER detection + launchctl asuser in mdm-asuser-notify-test.sh.
if [[ "$(id -u)" -eq 0 ]]; then
  SESSION_ID=""
  for sid in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
    if [[ "$(loginctl show-session "$sid" -p State --value 2>/dev/null || true)" == "active" ]]; then
      SESSION_ID="$sid"
      break
    fi
  done

  if [[ -z "$SESSION_ID" ]]; then
    echo "No active graphical session found — skipping notification." >&2
    exit 0
  fi

  CONSOLE_USER="$(loginctl show-session "$SESSION_ID" -p Name --value)"
  CONSOLE_UID="$(id -u "$CONSOLE_USER")"

  echo "Resolved console user: $CONSOLE_USER (uid $CONSOLE_UID)"
  echo "Firing as: $(whoami) (uid $(id -u))"

  # Serialize our own functions and replay them inside the target user's
  # `bash -c` — no dependency on this script ever existing as a file (see
  # header comment). runuser also resets the target session's environment,
  # which can leave PATH empty, so it's forced through explicitly too.
  INNER="$(declare -f open_terminal notify_and_wait)"$'\n''notify_and_wait "$1" "$2" "$3"'

  runuser -u "$CONSOLE_USER" -- env \
    PATH="$PATH" \
    DISPLAY="${DISPLAY:-:0}" \
    XDG_RUNTIME_DIR="/run/user/$CONSOLE_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$CONSOLE_UID/bus" \
    bash -c "$INNER" bash "$TITLE" "$MESSAGE" "$COMMAND"
  exit 0
fi

notify_and_wait "$TITLE" "$MESSAGE" "$COMMAND"

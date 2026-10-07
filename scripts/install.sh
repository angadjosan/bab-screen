#!/bin/bash
# Installs the B@B LaunchAgents on this Mac (run on the Mac mini, as the
# logged-in user, from a Terminal in the GUI session, not with sudo).
#
#   scripts/install.sh                    all three services
#   scripts/install.sh --only jarvis      one service (repeatable: --only screen --only kiosk)
#   scripts/install.sh --dry-run          render and lint the plists, change nothing
#   scripts/install.sh --uninstall        unload and remove (respects --only)
#
# Services: screen (Next app, with Worm's ears and voice), jarvis (the Slack agent),
# kiosk (Chrome on the dashboard). See README "Running on the Mac mini".
set -euo pipefail

# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

DRY_RUN=0
UNINSTALL=0
SELECTED=()

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      [[ $# -ge 2 ]] || { echo "--only needs a service name" >&2; exit 64; }
      SELECTED+=("$(normalize_service "$2")") || exit 64
      shift 2
      ;;
    --only=*)
      SELECTED+=("$(normalize_service "${1#--only=}")") || exit 64
      shift
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [[ ${#SELECTED[@]} -eq 0 ]]; then
  SELECTED=("${ALL_SERVICES[@]}")
fi

if [[ $EUID -eq 0 ]]; then
  echo "Run this as the logged-in user, not root: LaunchAgents live in that user's GUI session (gui/<uid>)." >&2
  exit 1
fi

say_do() {
  # Print a command; run it unless --dry-run.
  echo "+ $*"
  if [[ $DRY_RUN -eq 0 ]]; then
    "$@"
  fi
}

bootout() {
  local label
  label="$(label_for "$1")"
  if is_loaded "$1"; then
    say_do launchctl bootout "gui/$UID/$label" || true
    # bootout returns before the job is fully gone; bootstrap right after can
    # fail with "Input/output error".
    if [[ $DRY_RUN -eq 0 ]]; then
      local _try
      for _try in 1 2 3 4 5 6 7 8 9 10; do
        is_loaded "$1" || break
        sleep 0.5
      done
    fi
  fi
}

bootstrap() {
  local plist="$1" _attempt
  echo "+ launchctl bootstrap gui/$UID $plist"
  [[ $DRY_RUN -eq 1 ]] && return 0
  for _attempt in 1 2 3; do
    if launchctl bootstrap "gui/$UID" "$plist"; then
      return 0
    fi
    sleep 1
  done
  echo "launchctl bootstrap failed for $plist" >&2
  return 1
}

# ---- uninstall -------------------------------------------------------------

if [[ $UNINSTALL -eq 1 ]]; then
  for svc in "${SELECTED[@]}"; do
    bootout "$svc"
    plist="$AGENTS_DIR/$(label_for "$svc").plist"
    if [[ -f "$plist" ]]; then
      say_do rm -f "$plist"
    fi
  done
  echo
  echo "Logs are left in $LOG_DIR."
  if [[ -f /etc/newsyslog.d/com.bab.conf && ${#SELECTED[@]} -eq ${#ALL_SERVICES[@]} ]]; then
    echo "To remove log rotation too:  sudo rm /etc/newsyslog.d/com.bab.conf"
  fi
  exit 0
fi

# ---- install ---------------------------------------------------------------

if ! NODE_BIN_DIR="$(find_node_bin)"; then
  echo "node not found. Install it with nvm (nvm install 22 && nvm alias default 22) or set NODE_BIN." >&2
  exit 1
fi
if [[ ! -x "$NODE_BIN_DIR/node" || ! -x "$NODE_BIN_DIR/npm" ]]; then
  echo "no node/npm in $NODE_BIN_DIR" >&2
  exit 1
fi

# sed replacement text: escape \ & and the | delimiter. XML: escape & < >.
xml_escape() { local s="$1"; s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; printf '%s' "$s"; }
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

render() {
  # render <template> <out>
  sed \
    -e "s|@REPO_DIR@|$(sed_escape "$(xml_escape "$REPO_DIR")")|g" \
    -e "s|@NODE_BIN@|$(sed_escape "$(xml_escape "$NODE_BIN_DIR")")|g" \
    -e "s|@LOG_DIR@|$(sed_escape "$(xml_escape "$LOG_DIR")")|g" \
    -e "s|@HOME@|$(sed_escape "$(xml_escape "$HOME")")|g" \
    "$1" > "$2"
  if grep -q '@[A-Z_]*@' "$2"; then
    echo "unfilled placeholder in $2:" >&2
    grep -n '@[A-Z_]*@' "$2" >&2
    return 1
  fi
  plutil -lint -s "$2" >/dev/null || { plutil -lint "$2" >&2; return 1; }
}

echo "repo:     $REPO_DIR"
echo "node:     $NODE_BIN_DIR ($("$NODE_BIN_DIR/node" --version))"
echo "logs:     $LOG_DIR"
echo "services: ${SELECTED[*]}"
[[ $DRY_RUN -eq 1 ]] && echo "(dry run: nothing is changed)"
case "$NODE_BIN_DIR" in
  */.nvm/versions/*)
    echo "note: node comes from nvm and its path has the version in it. After switching node versions, run this script again." ;;
esac
echo

if [[ $DRY_RUN -eq 1 ]]; then
  OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bab-launchd.XXXXXX")"
else
  OUT_DIR="$AGENTS_DIR"
  mkdir -p "$AGENTS_DIR" "$LOG_DIR" "$PID_DIR"
fi

# Per-service checks before loading anything.
for svc in "${SELECTED[@]}"; do
  case "$svc" in
    screen)
      [[ -f "$REPO_DIR/.next/BUILD_ID" ]] || echo "warning: no production build yet. Run scripts/deploy.sh (or npm ci && npm run build) or com.bab.screen will keep restarting."
      [[ -x "$REPO_DIR/.data/tts-venv/bin/python3" ]] || echo "note: Worm's voice is not set up, so it speaks with macOS say. Run sh scripts/tts/setup.sh for Kokoro."
      ;;
    jarvis)
      [[ -f "$REPO_DIR/agent/index.ts" ]] || echo "warning: agent/index.ts does not exist yet; com.bab.jarvis will keep restarting."
      [[ -x "$REPO_DIR/node_modules/.bin/tsx" ]] || echo "warning: tsx is not installed (npm ci)."
      ;;
    kiosk)
      [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]] || echo "warning: Google Chrome is not in /Applications."
      ;;
  esac
done

for svc in "${SELECTED[@]}"; do
  label="$(label_for "$svc")"
  template="$LAUNCHD_SRC/$label.plist"
  out="$OUT_DIR/$label.plist"
  render "$template" "$out"
  echo "rendered $out"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "--- $label"
    cat "$out"
    echo
  fi
done

for svc in "${SELECTED[@]}"; do
  label="$(label_for "$svc")"
  bootout "$svc"
  bootstrap "$OUT_DIR/$label.plist"
done

# Secrets file: owner read/write only.
if [[ -f "$REPO_DIR/.env.local" ]]; then
  say_do chmod 600 "$REPO_DIR/.env.local"
else
  echo "warning: $REPO_DIR/.env.local does not exist yet (see JARVIS.md, Env). Create it, then: chmod 600 .env.local"
fi

# ---- log rotation (newsyslog, runs as root) ---------------------------------
# One line per log: rotate at 10 MB, keep 5, bzip2 them, then SIGTERM the
# pid written by run-service.sh so launchd restarts the job onto a new file.
NEWSYSLOG_CONF="$LOG_DIR/newsyslog-com.bab.conf"
NEWSYSLOG_DEST=/etc/newsyslog.d/com.bab.conf
newsyslog_text() {
  echo "# B@B Jarvis service logs. Generated by $REPO_DIR/scripts/install.sh."
  echo "# logfilename                                   owner:group  mode count size(KB) when flags pid_file sig"
  local svc
  for svc in "${ALL_SERVICES[@]}"; do
    printf '%s/%s.log\t%s:staff\t644\t5\t10240\t*\tJ\t%s/%s.pid\t15\n' \
      "$LOG_DIR" "$svc" "$(id -un)" "$PID_DIR" "$svc"
  done
}
echo
if [[ "$LOG_DIR" == *" "* ]]; then
  echo "warning: $LOG_DIR has a space in it; newsyslog can't rotate it. Skipping log rotation."
elif [[ $DRY_RUN -eq 1 ]]; then
  echo "newsyslog config that would be installed at $NEWSYSLOG_DEST:"
  newsyslog_text
elif [[ -f "$NEWSYSLOG_DEST" ]] && cmp -s <(newsyslog_text) "$NEWSYSLOG_DEST"; then
  echo "log rotation: $NEWSYSLOG_DEST is up to date."
else
  newsyslog_text > "$NEWSYSLOG_CONF"
  echo "log rotation needs root. Run once:"
  echo "  sudo install -m 644 -o root -g wheel '$NEWSYSLOG_CONF' $NEWSYSLOG_DEST"
fi

cat <<EOF

---- Manual steps (once per Mac) --------------------------------------------

1. Never sleep, restart after a power cut:
     sudo pmset -a sleep 0 displaysleep 0 autorestart 1
   and System Settings > Users & Groups > Automatically log in as: $(id -un).
   LaunchAgents only run once that user is logged in.

2. Privacy permissions (TCC). They can only be granted in the GUI, by someone
   at the screen; without them things fail silently. After installing, watch
   for prompts and allow them, then check System Settings > Privacy & Security:
   - Automation: the process running the agent and the screen (node) may
     control Spotify. Test: say "hey worm, skip this song".
   - Microphone: Worm's listener (.data/listen, started by the screen's node).
     If "hey worm" never brings up the stage, the permission was not granted.
   - Accessibility: only if a tool sends keystrokes; grant it to the same node.
   To re-trigger a missed prompt: tccutil reset Microphone (or AppleEvents),
   then launchctl kickstart -k gui/$UID/com.bab.screen

3. Remote access over Tailscale. Tailscale SSH needs the open-source
   tailscaled (brew install tailscale; sudo brew services start tailscale;
   sudo tailscale up --ssh). The App Store app can't be an SSH server; with it,
   turn on System Settings > General > Sharing > Remote Login instead and ssh
   to the Tailscale address. Then, to update: ssh $(id -un)@<mac-mini> and run
   $REPO_DIR/scripts/deploy.sh

Status:   launchctl print gui/$UID/com.bab.<screen|jarvis|kiosk>
Logs:     tail -f $LOG_DIR/*.log
EOF

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "(dry run) rendered plists are in $OUT_DIR"
fi

#!/bin/bash
# Started by com.bab.kiosk. Waits until the dashboard answers, then runs
# Google Chrome full screen on it.
#
# Chrome gets its own profile (~/Library/Application Support/bab-kiosk), so it
# is a separate instance from any Chrome a person opens on this Mac. With the
# normal profile, a second launch hands its URL to the running Chrome and
# exits at once, and launchd would keep restarting it.
set -euo pipefail

url="${KIOSK_URL:-http://127.0.0.1:3000}"
chrome="${KIOSK_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
profile="$HOME/Library/Application Support/bab-kiosk"

if [[ ! -x "$chrome" ]]; then
  echo "kiosk: Chrome not found at $chrome (set KIOSK_CHROME)" >&2
  exit 1
fi

waited=0
until curl -fs -o /dev/null --max-time 3 "$url"; do
  if (( waited % 30 == 0 )); then
    echo "kiosk: waiting for $url"
  fi
  sleep 2
  waited=$((waited + 2))
done

# After a kill (deploy, log rotation, power loss) Chrome marks the last exit
# as a crash and offers to restore pages. Mark it clean so it just opens.
prefs="$profile/Default/Preferences"
if [[ -f "$prefs" ]]; then
  sed -i '' -e 's/"exit_type":"Crashed"/"exit_type":"Normal"/' -e 's/"exited_cleanly":false/"exited_cleanly":true/' "$prefs" || true
fi

echo "kiosk: opening $url"
exec "$chrome" \
  --user-data-dir="$profile" \
  --kiosk \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate,TranslateUI \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  "$url"

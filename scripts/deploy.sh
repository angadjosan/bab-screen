#!/bin/bash
# Updates the Mac mini to the latest commit and restarts the services.
#
#   scripts/deploy.sh                 pull, npm ci, build, restart every installed service
#   scripts/deploy.sh jarvis voice    restart only these (still pulls and builds)
#
# Safe to run over SSH: it finds node itself and talks to the logged-in user's
# launchd session (gui/$UID).
set -euo pipefail

# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

SERVICES=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) SERVICES+=("$(normalize_service "$arg")") || exit 64 ;;
  esac
done
[[ ${#SERVICES[@]} -gt 0 ]] || SERVICES=("${ALL_SERVICES[@]}")

if [[ $EUID -eq 0 ]]; then
  echo "Run as the logged-in user, not root." >&2
  exit 1
fi

ensure_node_on_path
cd "$REPO_DIR"

before="$(git rev-parse HEAD)"
echo "+ git pull --ff-only"
git pull --ff-only
after="$(git rev-parse HEAD)"
if [[ "$before" != "$after" ]]; then
  git --no-pager log --oneline "$before..$after"
fi

changed() { [[ "$before" != "$after" ]] && ! git diff --quiet "$before" "$after" -- "$@"; }

# Dev dependencies are needed too (next build uses typescript; the agent runs on tsx).
echo "+ npm ci --include=dev"
npm ci --include=dev
echo "+ npm run build"
npm run build

if changed voice/requirements.txt && [[ -x voice/.venv/bin/pip ]]; then
  echo "+ voice/.venv/bin/pip install -r voice/requirements.txt"
  voice/.venv/bin/pip install -q -r voice/requirements.txt
fi

if changed launchd scripts/run-service.sh; then
  echo
  echo "note: launchd templates changed in this pull. Run scripts/install.sh to re-render and reload them."
fi

echo
for svc in "${SERVICES[@]}"; do
  label="$(label_for "$svc")"
  if [[ ! -f "$AGENTS_DIR/$label.plist" ]] || ! is_loaded "$svc"; then
    echo "skip $label (not installed)"
    continue
  fi
  echo "+ launchctl kickstart -k gui/$UID/$label"
  launchctl kickstart -k "gui/$UID/$label"
done

echo
echo "deployed $(git rev-parse --short HEAD). Logs: tail -f $LOG_DIR/*.log"

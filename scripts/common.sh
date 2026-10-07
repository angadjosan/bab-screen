# Shared by scripts/install.sh and scripts/deploy.sh. Source it; don't run it.
# shellcheck shell=bash
# shellcheck disable=SC2034  # the variables are used by the scripts that source this

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
LAUNCHD_SRC="$REPO_DIR/launchd"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/bab"
PID_DIR="$LOG_DIR/.pid"

# Start order matters only for the first boot: the kiosk waits for the screen anyway.
ALL_SERVICES=(screen jarvis kiosk)

label_for() { printf 'com.bab.%s' "$1"; }

# Accepts "screen" or "com.bab.screen"; prints the short name or fails.
normalize_service() {
  local s="${1#com.bab.}"
  local known
  for known in "${ALL_SERVICES[@]}"; do
    if [[ "$s" == "$known" ]]; then
      printf '%s' "$s"
      return 0
    fi
  done
  echo "unknown service: $1 (expected one of: ${ALL_SERVICES[*]})" >&2
  return 1
}

# The directory holding node and npm. launchd starts jobs with a bare PATH, so
# the plists carry this directory explicitly. Order: $NODE_BIN, node on PATH,
# nvm's default alias, the newest version under ~/.nvm/versions/node.
find_node_bin() {
  if [[ -n "${NODE_BIN:-}" ]]; then
    printf '%s' "$NODE_BIN"
    return 0
  fi
  local node
  if node="$(command -v node 2>/dev/null)" && [[ -n "$node" ]]; then
    dirname "$node"
    return 0
  fi
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$nvm_dir/nvm.sh" ]]; then
    local resolved
    # shellcheck disable=SC1091
    resolved="$( (source "$nvm_dir/nvm.sh" --no-use >/dev/null 2>&1 && nvm which default) 2>/dev/null || true)"
    if [[ -x "$resolved" ]]; then
      dirname "$resolved"
      return 0
    fi
  fi
  if [[ -d "$nvm_dir/versions/node" ]]; then
    local newest
    newest="$(find "$nvm_dir/versions/node" -mindepth 1 -maxdepth 1 -type d -name 'v*' | sort -V | tail -n 1)"
    if [[ -n "$newest" && -x "$newest/bin/node" ]]; then
      printf '%s/bin' "$newest"
      return 0
    fi
  fi
  return 1
}

# Ensure node/npm are callable from this script too (Tailscale SSH sessions
# often don't load nvm).
ensure_node_on_path() {
  local bin
  if ! bin="$(find_node_bin)"; then
    echo "node not found. Install it with nvm, or set NODE_BIN=/path/to/node/bin." >&2
    return 1
  fi
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) PATH="$bin:$PATH" ;;
  esac
  export PATH
  NODE_BIN_DIR="$bin"
}

is_loaded() { launchctl print "gui/$UID/$(label_for "$1")" >/dev/null 2>&1; }

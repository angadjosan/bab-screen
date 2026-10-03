#!/bin/bash
# Starts the voice daemon from voice/.venv. Used by launchd (com.bab.voice);
# also fine by hand: voice/run.sh --selftest
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
py="$dir/.venv/bin/python"
if [[ ! -x "$py" ]]; then
  echo "voice: $dir/.venv is missing. Run voice/setup.sh." >&2
  # Exit slowly so launchd's restarts don't spin.
  sleep 30
  exit 1
fi
# whisper-cli from Homebrew.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PYTHONUNBUFFERED=1
exec "$py" "$dir/daemon.py" "$@"

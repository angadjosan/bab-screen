#!/bin/bash
# launchd entry point for every com.bab.* job: run-service.sh <name> <command...>
#
# Writes this process's pid to ~/Library/Logs/bab/.pid/<name>.pid and then
# execs the command, so the pid stays the same. newsyslog sends that pid
# SIGTERM after it rotates <name>.log (see scripts/install.sh); launchd's
# KeepAlive starts the job again and it reopens a fresh log. launchd only
# opens StandardOutPath when a job starts, so without the restart the job
# would keep writing into the rotated file.
set -euo pipefail

name="${1:?usage: run-service.sh <name> <command...>}"
shift
[[ $# -gt 0 ]] || { echo "run-service.sh: no command for $name" >&2; exit 64; }

pid_dir="$HOME/Library/Logs/bab/.pid"
mkdir -p "$pid_dir"
echo $$ > "$pid_dir/$name.pid"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting $name: $*"
exec "$@"
